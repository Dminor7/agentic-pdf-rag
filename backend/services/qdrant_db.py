import os
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from langchain_google_genai import GoogleGenerativeAIEmbeddings
import uuid
import logging
try:
    from sentence_transformers import CrossEncoder
    cross_encoder = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
except ImportError:
    cross_encoder = None

logger = logging.getLogger(__name__)

qdrant_url = os.environ.get("QDRANT_URL", "http://localhost:6333")
gemini_api_key = os.environ.get("GEMINI_API_KEY", "")

client = QdrantClient(url=qdrant_url)

embeddings_model = GoogleGenerativeAIEmbeddings(
    model="models/gemini-embedding-001", google_api_key=gemini_api_key
)

COLLECTION_NAME = "pdf_chunks_v2"

def init_qdrant():
    try:
        collections = client.get_collections().collections
        names = [col.name for col in collections]
        if COLLECTION_NAME not in names:
            client.create_collection(
                collection_name=COLLECTION_NAME,
                vectors_config=VectorParams(size=3072, distance=Distance.COSINE),
            )
            logger.info("Created Qdrant collection.")
    except Exception as e:
        logger.error(f"Error initializing Qdrant: {e}")

def upsert_chunks(workspace_id: str, document_id: str, chunks: list):
    points = []
    texts = [c["text"] for c in chunks]
    # Compute embeddings in batch
    embeddings = embeddings_model.embed_documents(texts)
    
    for i, chunk in enumerate(chunks):
        payload = chunk["metadata"]
        payload["workspace_id"] = workspace_id
        payload["document_id"] = document_id
        payload["text"] = chunk["text"]
        
        points.append(
            PointStruct(
                id=str(uuid.uuid4()),
                vector=embeddings[i],
                payload=payload
            )
        )
    
    client.upsert(
        collection_name=COLLECTION_NAME,
        points=points
    )

def get_raw_chunks(workspace_id: str, query: str, limit: int = 10):
    query_vector = embeddings_model.embed_query(query)
    
    search_result = client.query_points(
        collection_name=COLLECTION_NAME,
        query=query_vector,
        query_filter={
            "must": [
                {
                    "key": "workspace_id",
                    "match": {
                        "value": workspace_id
                    }
                }
            ]
        },
        limit=limit,
        with_payload=True,
    )
    
    # Store ID along with payload for deduplication later
    candidates = []
    for hit in search_result.points:
        payload = hit.payload or {}
        payload["_point_id"] = str(hit.id)
        candidates.append(payload)
        
    return candidates

def rerank_global_candidates(query: str, candidates: list, top_k: int = 10):
    if cross_encoder and candidates:
        scores = cross_encoder.predict([(query, c.get("text", "")) for c in candidates])
        for c, s in zip(candidates, scores):
            c["rerank_score"] = float(s)
        candidates = sorted(candidates, key=lambda x: x.get("rerank_score", 0), reverse=True)
        
    return candidates[:top_k]

def search_chunks(workspace_id: str, query: str, top_k: int = 5):
    candidates = get_raw_chunks(workspace_id, query, limit=15)
    return rerank_global_candidates(query, candidates, top_k=top_k)

from qdrant_client.models import Filter, FieldCondition, MatchValue

def delete_document_chunks(document_id: str):
    try:
        client.delete(
            collection_name=COLLECTION_NAME,
            points_selector=Filter(
                must=[FieldCondition(key="document_id", match=MatchValue(value=document_id))]
            )
        )
    except Exception as e:
        logger.error(f"Failed to delete document chunks {document_id}: {e}")

def delete_workspace_chunks(workspace_id: str):
    try:
        client.delete(
            collection_name=COLLECTION_NAME,
            points_selector=Filter(
                must=[FieldCondition(key="workspace_id", match=MatchValue(value=workspace_id))]
            )
        )
    except Exception as e:
        logger.error(f"Failed to delete workspace chunks {workspace_id}: {e}")
