"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface AnalysisData {
  filename: string;
  total_pages: number;
  vlm_recommended: number;
  standard_recommended: number;
  classification: Record<string, string>;
}

export default function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const unwrappedParams = use(params);
  const id = unwrappedParams.id;
  
  const [documents, setDocuments] = useState<any[]>([]);
  const [file, setFile] = useState<File | null>(null);
  
  // Wizard States
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null);
  const [selectedMode, setSelectedMode] = useState<"auto" | "vlm" | "standard">("auto");
  const [isUploading, setIsUploading] = useState(false);
  const [status, setStatus] = useState<{type: 'error' | 'success', msg: string} | null>(null);

  const router = useRouter();

  const fetchDocs = async () => {
    const res = await fetch(`http://localhost:8000/api/workspaces/${id}/documents`);
    if (res.ok) setDocuments(await res.json());
  };

  useEffect(() => { fetchDocs(); }, [id]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] || null);
    setAnalysisData(null);
    setStatus(null);
  };

  const handleDeleteDoc = async (docId: string) => {
    if (!confirm("Delete this document and all its indexed context?")) return;
    try {
      const res = await fetch(`http://localhost:8000/api/workspaces/${id}/documents/${docId}`, {
        method: "DELETE"
      });
      if (res.ok) {
        fetchDocs();
        setStatus({ type: 'success', msg: "Document deleted."});
      } else {
        setStatus({ type: 'error', msg: "Failed to delete document." });
      }
    } catch (err: any) {
      setStatus({ type: 'error', msg: "Error deleting document." });
    }
  };

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setIsAnalyzing(true);
    setStatus(null);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`http://localhost:8000/api/workspaces/${id}/documents/analyze`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(await res.text() || "Analysis failed");
      const data = await res.json();
      setAnalysisData(data);
    } catch (err: any) {
      console.error(err);
      setStatus({ type: 'error', msg: err.message || "Network error. Please try again." });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setIsUploading(true);
    setStatus(null);
    
    const formData = new FormData();
    formData.append("file", file);
    formData.append("mode", selectedMode);

    try {
      const res = await fetch(`http://localhost:8000/api/workspaces/${id}/documents`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(await res.text() || "Upload failed");
      
      setStatus({ type: 'success', msg: "Document parsed and indexed successfully!" });
      setFile(null);
      setAnalysisData(null);
      fetchDocs();
    } catch (err: any) {
      console.error(err);
      setStatus({ type: 'error', msg: err.message || "Network error. Please try again." });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8 text-black">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="flex justify-between items-center bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Workspace</h1>
            <p className="text-sm text-gray-500">Workspace ID: {id}</p>
          </div>
          <Link 
            href={`/workspaces/${id}/chat`}
            className="px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition"
          >
            Enter Chat
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex flex-col space-y-6">
            <h2 className="text-lg font-semibold text-gray-800 border-b pb-2">Intelligent Indexing</h2>
            
            {/* Step 1: Select & Analyze */}
            <form onSubmit={handleAnalyze} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Step 1: Select Document</label>
                <input
                  type="file"
                  accept=".pdf"
                  onChange={handleFileChange}
                  className="block w-full text-sm text-gray-500 border border-gray-200 rounded-lg cursor-pointer bg-gray-50 p-2"
                />
              </div>
              
              {!analysisData && (
                <button
                  type="submit"
                  disabled={!file || isAnalyzing || isUploading}
                  className="w-full py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50 hover:bg-blue-700 transition flex items-center justify-center font-medium"
                >
                  {isAnalyzing ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                      Analyzing Document...
                    </>
                  ) : "Analyze Document"}
                </button>
              )}
            </form>

            {/* Step 2: Analysis Results & Indexing */}
            {analysisData && (
              <form onSubmit={handleUpload} className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="bg-blue-50 border border-blue-100 rounded-lg p-4">
                  <h3 className="text-sm font-bold text-blue-900 mb-2">Analysis Results</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex flex-col">
                      <span className="text-blue-700/80">Total Pages</span>
                      <span className="font-semibold text-blue-900">{analysisData.total_pages}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-blue-700/80">Visual Pages (VLM)</span>
                      <span className="font-semibold text-blue-900">{analysisData.vlm_recommended}</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="block text-sm font-medium text-gray-700">Step 2: Processing Mode</label>
                  
                  <label className={`flex items-start p-3 border rounded-lg cursor-pointer transition ${selectedMode === 'auto' ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200 bg-white'}`}>
                    <input type="radio" className="mt-1" checked={selectedMode === 'auto'} onChange={() => setSelectedMode('auto')} />
                    <div className="ml-3">
                      <p className="text-sm font-medium text-gray-900">Auto (Hybrid Pipeline)</p>
                      <p className="text-xs text-gray-500">Dynamically routes complex pages to VLM and simple pages to fast CPU.</p>
                    </div>
                  </label>

                  <label className={`flex items-start p-3 border rounded-lg cursor-pointer transition ${selectedMode === 'vlm' ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200 bg-white'}`}>
                    <input type="radio" className="mt-1" checked={selectedMode === 'vlm'} onChange={() => setSelectedMode('vlm')} />
                    <div className="ml-3">
                      <p className="text-sm font-medium text-gray-900">Force Vision (VLM)</p>
                      <p className="text-xs text-gray-500">Treats all pages as images. Uses heavy visual model for high accuracy.</p>
                    </div>
                  </label>

                  <label className={`flex items-start p-3 border rounded-lg cursor-pointer transition ${selectedMode === 'standard' ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200 bg-white'}`}>
                    <input type="radio" className="mt-1" checked={selectedMode === 'standard'} onChange={() => setSelectedMode('standard')} />
                    <div className="ml-3">
                      <p className="text-sm font-medium text-gray-900">Force Standard</p>
                      <p className="text-xs text-gray-500">Ignores images. High speed CPU text extraction only.</p>
                    </div>
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={!file || isUploading}
                  className="w-full py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 hover:bg-gray-900 transition flex items-center justify-center font-medium"
                >
                  {isUploading ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                      Extracting & Indexing...
                    </>
                  ) : "Parse & Index Document"}
                </button>
              </form>
            )}

            {status && (
              <div className={`p-3 rounded-lg text-sm ${status.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
                {status.msg}
              </div>
            )}
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 border-b pb-2">Indexed Documents</h2>
            {documents.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">No documents uploaded yet.</p>
            ) : (
              <ul className="space-y-3">
                {documents.map((doc) => (
                  <li key={doc.id} className="flex justify-between items-center p-3 border border-gray-100 rounded-lg bg-gray-50 group transition">
                    <div className="flex flex-col">
                      <span className="font-medium text-gray-800 break-all">{doc.filename}</span>
                      <span className="text-xs text-gray-400">{new Date(doc.created_at).toLocaleString()}</span>
                    </div>
                    <button 
                      onClick={() => handleDeleteDoc(doc.id)}
                      className="opacity-0 group-hover:opacity-100 px-3 py-1.5 ml-2 bg-red-50 text-red-600 border border-red-100 text-xs font-semibold rounded hover:bg-red-100 transition"
                      title="Delete document"
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
