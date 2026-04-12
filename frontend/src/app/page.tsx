"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function Home() {
  const [name, setName] = useState("");
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const router = useRouter();

  const fetchWorkspaces = async () => {
    try {
      const res = await fetch("http://localhost:8000/api/workspaces");
      if (res.ok) setWorkspaces(await res.json());
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("http://localhost:8000/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const data = await res.json();
      router.push(`/workspaces/${data.id}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to completely delete this workspace, including all documents and vector chunks?")) return;
    
    const res = await fetch(`http://localhost:8000/api/workspaces/${id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      fetchWorkspaces();
    }
  };

  return (
    <div className="flex flex-col items-center min-h-screen bg-gray-50 py-12 px-4">
      <h1 className="text-4xl font-extrabold mb-10 text-center text-gray-900 tracking-tight">PDF Lake</h1>
      
      <div className="flex flex-col md:flex-row gap-8 w-full max-w-5xl">
        {/* Create Workspace Panel */}
        <div className="p-8 bg-white rounded-2xl shadow-sm border border-gray-200 flex-1 md:max-w-md h-fit">
          <h2 className="text-xl font-bold mb-2 text-gray-800">New Workspace</h2>
          <p className="text-sm text-gray-500 mb-6">Create an isolated environment for your documents.</p>
          
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Workspace Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 block w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-blue-500 focus:border-blue-500 text-gray-800 transition shadow-inner"
                placeholder="e.g. Q1 Earnings"
              />
            </div>
            <button
              type="submit"
              className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
            >
              Create Workspace
            </button>
          </form>
        </div>

        {/* List Workspaces Panel */}
        <div className="p-8 bg-white rounded-2xl shadow-sm border border-gray-200 flex-1">
          <h2 className="text-xl font-bold mb-6 text-gray-800 border-b pb-4">Active Workspaces</h2>
          
          {workspaces.length === 0 ? (
            <p className="text-center py-10 text-gray-400 text-sm">No workspaces created yet.</p>
          ) : (
            <div className="space-y-4">
              {workspaces.map((ws) => (
                <div key={ws.id} className="flex flex-col sm:flex-row justify-between items-center bg-gray-50 p-4 border border-gray-100 rounded-xl hover:shadow-md transition">
                  <div className="mb-4 sm:mb-0">
                    <h3 className="font-semibold text-gray-900">{ws.name}</h3>
                    <p className="text-xs text-gray-500">Created {new Date(ws.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="flex gap-2">
                    <Link 
                      href={`/workspaces/${ws.id}`}
                      className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition"
                    >
                      Open
                    </Link>
                    <button 
                      onClick={() => handleDelete(ws.id)}
                      className="px-4 py-2 bg-red-50 text-red-600 text-sm font-medium rounded-lg hover:bg-red-100 border border-red-100 transition"
                      title="Delete Workspace"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
