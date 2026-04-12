from pydantic import BaseModel
from typing import List, Optional
import datetime

class WorkspaceCreate(BaseModel):
    name: str

class WorkspaceResponse(BaseModel):
    id: str
    name: str
    created_at: datetime.datetime

    class Config:
        orm_mode = True

class DocumentResponse(BaseModel):
    id: str
    filename: str
    file_path: str
    created_at: datetime.datetime

    class Config:
        orm_mode = True

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[ChatMessage]

class Citation(BaseModel):
    page: int
    bbox: dict
    source: str
