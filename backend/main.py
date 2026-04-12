from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import workspaces
from database import engine, Base
from services.qdrant_db import init_qdrant
import os

from fastapi.staticfiles import StaticFiles

Base.metadata.create_all(bind=engine)

app = FastAPI(title="PDF Lake API. Developed By Darsh Shukla (contact.dshukla@gmail.com)")

# Setup CORS for the frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Since it's local auth/demo
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

app.include_router(workspaces.router)

@app.on_event("startup")
async def startup_event():
    init_qdrant()

@app.get("/")
def read_root():
    return {"status": "ok"}
