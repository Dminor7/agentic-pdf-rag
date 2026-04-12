import os
import fitz
import torch
import logging
from typing import List, Dict, Any
from pathlib import Path
import uuid

from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, VlmPipelineOptions
from docling.datamodel.pipeline_options_vlm_model import ApiVlmOptions, ResponseFormat
from docling.datamodel.settings import settings
from docling.pipeline.vlm_pipeline import VlmPipeline
from docling.chunking import HybridChunker

logger = logging.getLogger(__name__)

def get_device():
    if torch.cuda.is_available():
        return "cuda"
    elif torch.backends.mps.is_built() and torch.backends.mps.is_available():
        return "mps"
    return "cpu"

def classify_pages(pdf_path: Path, mode: str) -> Dict[int, str]:
    """Returns {page_no: 'vlm' | 'standard'} for every page."""
    doc = fitz.open(str(pdf_path))
    result = {}
    for i, page in enumerate(doc, start=1):
        if mode == "vlm":
            result[i] = "vlm"
        elif mode == "standard":
            result[i] = "standard"
        else:
            images = page.get_images(full=True)
            text = page.get_text().strip()
            needs_vlm = (len(images) >= 2 or (len(images) >= 1 and len(text) < 300) or len(text) < 100)
            result[i] = "vlm" if needs_vlm else "standard"
    doc.close()
    return result

def get_page_dimensions(pdf_path: Path) -> Dict[int, tuple[float, float]]:
    doc = fitz.open(str(pdf_path))
    dims = {}
    for i, page in enumerate(doc, start=1):
        rect = page.rect
        dims[i] = (rect.width, rect.height)
    doc.close()
    return dims

GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"

def build_vlm_converter() -> DocumentConverter:
    api_key_val = os.environ.get("GEMINI_API_KEY", "")
    vlm_options = ApiVlmOptions(
        url=GEMINI_OPENAI_URL,
        headers={"Authorization": f"Bearer {api_key_val}"},
        params={
            "model":       "gemini-3.1-flash-lite-preview",
            "max_tokens":  8192,
            "temperature": 0.0,
            "top_p":       0.95,
        },
        prompt="""You are a financial document analyst. Convert this page to markdown.
Rules:
- Bar/waterfall charts → markdown table with all bar labels and exact values
- Pie/donut charts     → markdown table with segment name and percentage
- Financial tables     → full | markdown table, every row, every number exactly
- Text/headings        → preserve # ## ### hierarchy
- Asset photos         → one-line description only
- NEVER approximate numbers. Write "2,157" not "~2000"
- Output ONLY markdown. No commentary.""",
        timeout=300,
        scale=1.5,
        response_format=ResponseFormat.MARKDOWN,
        concurrency=1,
    )
    pipeline_options = VlmPipelineOptions(
        vlm_options=vlm_options,
        enable_remote_services=True,
    )
    settings.perf.page_batch_size = 4
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_cls=VlmPipeline,
                pipeline_options=pipeline_options,
            )
        }
    )

def build_standard_converter() -> DocumentConverter:
    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_table_structure = True
    pipeline_options.do_ocr = False
    
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
        }
    )

def extract_page(pdf_path: Path, page_no: int, tmp_dir: Path) -> Path:
    src = fitz.open(str(pdf_path))
    out = fitz.open()
    out.insert_pdf(src, from_page=page_no - 1, to_page=page_no - 1)
    tmp = tmp_dir / f"_page_{page_no:04d}.pdf"
    out.save(str(tmp))
    out.close()
    src.close()
    return tmp

def process_pdf(file_path_str: str, mode: str) -> List[Dict[str, Any]]:
    device = get_device()
    logger.info(f"Processing {file_path_str} | mode={mode} | device={device}")

    pdf_path = Path(file_path_str)
    source_file = pdf_path.name
    tmp_dir = pdf_path.parent / f"_tmp_{pdf_path.stem}_{uuid.uuid4().hex[:6]}"
    tmp_dir.mkdir(exist_ok=True)

    classification = classify_pages(pdf_path, mode)
    page_dims = get_page_dimensions(pdf_path)
    
    vlm_count = sum(1 for t in classification.values() if t == "vlm")
    standard_count = len(classification) - vlm_count

    vlm_conv = build_vlm_converter() if vlm_count else None
    standard_conv = build_standard_converter() if standard_count else None

    chunker = HybridChunker(max_tokens=512)
    chunks_for_db = []

    for page_no in sorted(classification.keys()):
        page_mode = classification[page_no]
        tmp_pdf = extract_page(pdf_path, page_no, tmp_dir)
        conv = vlm_conv if page_mode == "vlm" else standard_conv
        
        try:
            logger.info(f"Page {page_no} [{page_mode.upper()}] parsing...")
            doc_result = conv.convert(str(tmp_pdf))
            doc = doc_result.document
            
            p_width, p_height = page_dims.get(page_no, (595.0, 842.0))
            
            for chunk in chunker.chunk(doc):
                bbox_info = []
                for doc_item in chunk.meta.doc_items:
                    for prov in doc_item.prov:
                        bbox = prov.bbox
                        left = (bbox.l / p_width) * 100
                        top = ((p_height - bbox.t) / p_height) * 100
                        width = ((bbox.r - bbox.l) / p_width) * 100
                        height = ((bbox.t - bbox.b) / p_height) * 100
                        
                        bbox_info.append({
                            "pageIndex": page_no - 1,
                            "left": left,
                            "top": top,
                            "width": width,
                            "height": height
                        })
                
                chunk_text = chunker.serialize(chunk)
                chunks_for_db.append({
                    "text": chunk_text,
                    "metadata": {
                        "source": source_file,
                        "bboxes": bbox_info,
                        "parse_mode": page_mode
                    }
                })
        except Exception as e:
            logger.warning(f"Failed parsing page {page_no}: {e}")
        finally:
            tmp_pdf.unlink(missing_ok=True)
            
    try:
        tmp_dir.rmdir()
    except:
        pass

    return chunks_for_db
