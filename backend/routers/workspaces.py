from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
import os
import uuid
import json
import logging
from typing import List

from database import get_db, Workspace, Document, Message
from models import WorkspaceCreate, WorkspaceResponse, DocumentResponse, ChatRequest
from services.doc_parser import process_pdf, classify_pages
from services.qdrant_db import (
    upsert_chunks, search_chunks, delete_workspace_chunks, delete_document_chunks, 
    get_raw_chunks, rerank_global_candidates
)
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage
from pathlib import Path

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])

llm = ChatGoogleGenerativeAI(model="gemini-3.1-flash-lite-preview", google_api_key=os.environ.get("GEMINI_API_KEY", ""), temperature=0.2)

@router.post("", response_model=WorkspaceResponse)
def create_workspace(workspace: WorkspaceCreate, db: Session = Depends(get_db)):
    db_workspace = Workspace(id=str(uuid.uuid4()), name=workspace.name)
    db.add(db_workspace)
    db.commit()
    db.refresh(db_workspace)
    return db_workspace

@router.get("", response_model=List[WorkspaceResponse])
def get_workspaces(db: Session = Depends(get_db)):
    return db.query(Workspace).order_by(Workspace.created_at.desc()).all()

@router.get("/{workspace_id}", response_model=WorkspaceResponse)
def get_workspace(workspace_id: str, db: Session = Depends(get_db)):
    workspace = db.query(Workspace).filter(Workspace.id == workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return workspace

@router.delete("/{workspace_id}")
def delete_workspace(workspace_id: str, db: Session = Depends(get_db)):
    workspace = db.query(Workspace).filter(Workspace.id == workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    
    docs = db.query(Document).filter(Document.workspace_id == workspace_id).all()
    for doc in docs:
        if os.path.exists(doc.file_path):
            try: os.remove(doc.file_path)
            except: pass
    
    db.query(Document).filter(Document.workspace_id == workspace_id).delete()
    db.query(Message).filter(Message.workspace_id == workspace_id).delete()
    db.query(Workspace).filter(Workspace.id == workspace_id).delete()
    db.commit()
    
    delete_workspace_chunks(workspace_id)
    return {"message": "Workspace deleted successfully."}

@router.get("/{workspace_id}/documents", response_model=List[DocumentResponse])
def get_documents(workspace_id: str, db: Session = Depends(get_db)):
    return db.query(Document).filter(Document.workspace_id == workspace_id).all()

@router.post("/{workspace_id}/documents/analyze")
async def analyze_document(workspace_id: str, file: UploadFile = File(...)):
    os.makedirs("uploads", exist_ok=True)
    temp_path = f"uploads/temp_analyze_{uuid.uuid4()}_{file.filename}"
    with open(temp_path, "wb") as f:
        f.write(await file.read())
    
    classification = classify_pages(Path(temp_path), mode="auto")
    vlm_count = sum(1 for v in classification.values() if v == "vlm")
    total_pages = len(classification)
    
    # Clean up right away to save disk
    try:
        os.remove(temp_path)
    except:
        pass
        
    return {
        "filename": file.filename,
        "total_pages": total_pages,
        "vlm_recommended": vlm_count,
        "standard_recommended": total_pages - vlm_count,
        "classification": classification
    }

@router.post("/{workspace_id}/documents", response_model=DocumentResponse)
async def upload_document(
    workspace_id: str, 
    file: UploadFile = File(...), 
    mode: str = Form("auto"),
    db: Session = Depends(get_db)
):
    workspace = db.query(Workspace).filter(Workspace.id == workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    os.makedirs("uploads", exist_ok=True)
    file_path = f"uploads/{uuid.uuid4()}_{file.filename}"
    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    doc_id = str(uuid.uuid4())
    db_doc = Document(id=doc_id, workspace_id=workspace_id, filename=file.filename, file_path=file_path)
    db.add(db_doc)
    db.commit()
    db.refresh(db_doc)

    # Process and index
    chunks = process_pdf(file_path, mode=mode)
    if chunks:
        upsert_chunks(workspace_id=workspace_id, document_id=doc_id, chunks=chunks)

    return db_doc

@router.delete("/{workspace_id}/documents/{document_id}")
def delete_document(workspace_id: str, document_id: str, db: Session = Depends(get_db)):
    doc = db.query(Document).filter(Document.id == document_id, Document.workspace_id == workspace_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    if os.path.exists(doc.file_path):
        try: os.remove(doc.file_path)
        except: pass
        
    db.delete(doc)
    db.commit()
    
    delete_document_chunks(document_id)
    return {"message": "Document deleted successfully."}

@router.post("/{workspace_id}/chat")
async def chat(workspace_id: str, request: ChatRequest, db: Session = Depends(get_db)):
    user_msg = request.messages[-1].content
    
    async def generate():
        try:
            import asyncio
            yield f'7:{json.dumps(["Analyzing query complexity..."])}' + '\n'
            
            loop = asyncio.get_event_loop()
            
            # 1. Initial retrieval for decomposition grounding
            yield f'7:{json.dumps(["Initial semantic search for baseline..."])}' + '\n'
            init_chunks = await loop.run_in_executor(None, get_raw_chunks, workspace_id, user_msg, 5)
            init_context = '\n'.join([c.get("text", "") for c in init_chunks])

            # 2. Decompose
            yield f'7:{json.dumps(["Decomposing query into multi-agent search paths..."])}' + '\n'
            decomp_prompt = f"""You are a research agent. The user asked: "{user_msg}"
Based on this query and a quick glance at the document context below, explicitly decompose this into 3 specific, targeted search queries to thoroughly extract the right numbers, facts, and statements. 
Return EXACTLY a JSON array of 3 strings. Do NOT wrap in markdown code blocks. Just the array.
[CONTEXT GLANCE]: {init_context[:1000]}"""
            
            try:
                decomp_res = await llm.ainvoke([HumanMessage(content=decomp_prompt)])
                content_val = decomp_res.content
                if isinstance(content_val, list):
                    content_val = "".join([c.get("text", "") if isinstance(c, dict) else str(c) for c in content_val])
                elif not isinstance(content_val, str):
                    content_val = str(content_val)
                    
                raw_text = content_val.replace('```json', '').replace('```', '').strip()
                subqueries = json.loads(raw_text)
                if not isinstance(subqueries, list):
                    subqueries = [user_msg]
            except Exception as e:
                logger.warning(f"Decomposition failed: {e}")
                subqueries = [user_msg]
                
            yield f'7:{json.dumps([f"Generated {len(subqueries)} search paths:"] + [f"- {sq}" for sq in subqueries])}' + '\n'
            
            # 3. Parallel Retrieve
            yield f'7:{json.dumps(["Executing parallel vector searches against Qdrant DB..."])}' + '\n'
            tasks = [loop.run_in_executor(None, get_raw_chunks, workspace_id, sq, 10) for sq in subqueries]
            results_lists = await asyncio.gather(*tasks)
            
            # 4. Pool & Deduplicate
            yield f'7:{json.dumps(["Pooling document chunks and deduplicating clusters..."])}' + '\n'
            unique_chunks = {}
            for chunks in results_lists:
                for c in chunks:
                    pid = c.get("_point_id", str(uuid.uuid4()))
                    unique_chunks[pid] = c
                    
            yield f'7:{json.dumps([f"Aggregated {len(unique_chunks)} unique document passages."])}' + '\n'
            
            # 5. Global Rerank
            yield f'7:{json.dumps(["Engaging cross-encoder reranker to extract top 8 segments..."])}' + '\n'
            candidates = list(unique_chunks.values())
            final_top = await loop.run_in_executor(None, rerank_global_candidates, user_msg, candidates, 8)
            
            yield f'7:{json.dumps(["Synthesizing final analytical response..."])}' + '\n'
            
            # Format context and track sources
            context_text = ""
            citations_payload = []
            
            for i, c in enumerate(final_top):
                source_id = f"c{i+1}"
                text = c.get("text", "")
                bboxes = c.get("bboxes", [])
                page_val = bboxes[0]["pageIndex"] + 1 if bboxes else "Unknown"
                
                context_text += f'\\n[Document Chunk ID: {source_id}] [Page: {page_val}]\\n{text}\\n'
                citations_payload.append({
                    "id": source_id,
                    "page": page_val,
                    "bboxes": bboxes,
                    "text": text[:200] + "..." # snippet
                })
                
            yield f'8:{json.dumps(citations_payload)}' + '\n'
            
            sys_prompt = f"""You are a helpful AI analyst answering questions based on the provided document excerpts.
Your goal is to answer the user's question accurately using ONLY the provided excerpts.
Always cite your sources using the Chunk ID and Page, exactly matching this format: "According to the report [c1 p12], sales grew."
You must place these citation brackets directly at the end of the sentence or bullet point they support.
If the answer is not present in the retrieved context, you MUST respond exactly with: 'Not found in the document.' Do not hallucinate.

CONTEXT EXCERPTS:
{context_text}
"""
            final_messages = [SystemMessage(content=sys_prompt)]
            for m in request.messages:
                final_messages.append(HumanMessage(content=m.content))
                
            async for chunk in llm.astream(final_messages):
                if chunk.content:
                    text_val = chunk.content
                    if isinstance(text_val, list):
                        text_val = "".join([c.get("text", "") if isinstance(c, dict) else str(c) for c in text_val])
                    elif not isinstance(text_val, str):
                        text_val = str(text_val)
                        
                    yield f'0:{json.dumps(text_val)}' + '\n'

        except Exception as e:
            import sys
            logger.error(f"Global pipeline error: {sys.exc_info()}")
            yield f'0:{json.dumps(f"System encountered a catastrophic error: {e}")}' + '\n'

    return StreamingResponse(generate(), media_type="text/event-stream")
