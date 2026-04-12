"use client";

import { use, useState, useEffect, useRef } from "react";
import { Viewer, Worker } from "@react-pdf-viewer/core";
import { defaultLayoutPlugin } from "@react-pdf-viewer/default-layout";
import { highlightPlugin, Trigger } from "@react-pdf-viewer/highlight";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import "@react-pdf-viewer/core/lib/styles/index.css";
import "@react-pdf-viewer/default-layout/lib/styles/index.css";
import "@react-pdf-viewer/highlight/lib/styles/index.css";

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: any[];
  thoughts?: string[];
}

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const unwrappedParams = use(params);
  const id = unwrappedParams.id;
  
  const [activeCitation, setActiveCitation] = useState<any | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  
  // Highlight plugin setup
  const highlightPluginInstance = highlightPlugin({
    trigger: Trigger.None,
    renderHighlights: (renderProps) => {
      if (!activeCitation || !activeCitation.bboxes) return <></>;
      
      const areas = activeCitation.bboxes.map((b: any) => ({
        pageIndex: b.pageIndex,
        left: b.left,
        top: b.top,
        height: b.height,
        width: b.width,
      }));

      return (
        <div>
          {areas
            .filter((a: any) => a.pageIndex === renderProps.pageIndex)
            .map((area: any, idx: number) => (
              <div
                key={idx}
                style={{
                  ...renderProps.getCssProperties(area, renderProps.rotation),
                  background: 'rgba(255, 255, 0, 0.4)',
                  position: 'absolute',
                  border: '2px solid rgba(255, 204, 0, 0.8)',
                  borderRadius: '4px'
                }}
              />
            ))}
        </div>
      );
    },
  });

  const { jumpToHighlightArea } = highlightPluginInstance;

  useEffect(() => {
    if (activeCitation && activeCitation.bboxes && activeCitation.bboxes[0]) {
      const b = activeCitation.bboxes[0];
      jumpToHighlightArea({
        pageIndex: b.pageIndex,
        left: b.left,
        top: b.top,
        width: b.width,
        height: b.height,
      });
    }
  }, [activeCitation, jumpToHighlightArea]);

  useEffect(() => {
    const fetchDocs = async () => {
      try {
        const res = await fetch(`http://localhost:8000/api/workspaces/${id}/documents`);
        if (res.ok) {
          const docs = await res.json();
          if (docs.length > 0) {
            setPdfUrl(`http://localhost:8000/${docs[0].file_path}`);
          }
        }
      } catch (e) {
        console.error("Failed to fetch documents, backend might be starting:", e);
      }
    };
    fetchDocs();
  }, [id]);

  const defaultLayoutPluginInstance = defaultLayoutPlugin();

  const handleCitationClick = (citationId: string, messageId: string) => {
    const msg = messages.find(m => m.id === messageId);
    if (msg && msg.citations) {
      const found = msg.citations.find(c => c.id === citationId);
      if (found) {
        setActiveCitation(found);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { id: Date.now().toString(), role: 'user', content: input };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);

    const assistantId = (Date.now() + 1).toString();
    setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', citations: [], thoughts: [] }]);

    try {
      const res = await fetch(`http://localhost:8000/api/workspaces/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages })
      });

      if (!res.ok) throw new Error("Failed to chat");

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        let contentAccumulator = "";
        let citationsAccumulator: any[] = [];
        let thoughtsAccumulator: string[] = [];
        let streamBuffer = "";
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          streamBuffer += decoder.decode(value, { stream: true });
          const parts = streamBuffer.split("\n");
          streamBuffer = parts.pop() || ""; // Retain incomplete chunk
          
          for (const part of parts) {
            if (!part.trim()) continue;
            
            if (part.startsWith('7:')) {
              try {
                const newThoughts = JSON.parse(part.substring(2));
                thoughtsAccumulator = [...thoughtsAccumulator, ...newThoughts];
                setMessages(prev => prev.map(m => 
                  m.id === assistantId ? { ...m, thoughts: thoughtsAccumulator } : m
                ));
              } catch (e) { console.error("SSE 7 error:", e, "part:", part); }
            } else if (part.startsWith('8:')) {
              try {
                const cits = JSON.parse(part.substring(2));
                citationsAccumulator = cits;
                setMessages(prev => prev.map(m => 
                  m.id === assistantId ? { ...m, citations: citationsAccumulator } : m
                ));
              } catch (e) { console.error("SSE 8 error:", e, "part:", part); }
            } else if (part.startsWith('0:')) {
              try {
                const textChunk = JSON.parse(part.substring(2));
                const safeString = typeof textChunk === 'string' ? textChunk : JSON.stringify(textChunk);
                contentAccumulator += safeString;
                setMessages(prev => prev.map(m => 
                  m.id === assistantId ? { ...m, content: contentAccumulator } : m
                ));
              } catch (e) { console.error("SSE 0 error:", e, "part:", part); }
            }
          }
        }
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-gray-50 flex-col md:flex-row text-black">
      {/* Sidebar: Chat */}
      <div className="w-full md:w-1/3 border-r border-gray-200 bg-white flex flex-col shadow-lg z-10">
        <div className="p-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Chat Analyst</h2>
          <span className="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded-full">{id.slice(0, 8)}</span>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((m) => (
            <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[90%] p-4 rounded-2xl ${
                m.role === 'user' 
                  ? 'bg-blue-600 text-white rounded-tr-sm' 
                  : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'
              }`}>
                {m.role === 'user' ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</p>
                ) : (
                  <div>
                    {m.thoughts && m.thoughts.length > 0 && (
                      <div className="bg-blue-50 border border-blue-200 text-blue-800 text-xs p-3 rounded mb-3 font-mono shadow-sm">
                        <div className="font-bold flex items-center justify-between mb-2">
                          <div className="flex items-center">
                            {(!m.content || m.content.length === 0) && (
                              <svg className="animate-spin h-3 w-3 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                <circle className="opacity-25" cx="12" cy="12" r="10" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                            )}
                            Deep Research Agent Trace
                          </div>
                        </div>
                        <ul className="list-disc pl-4 space-y-1">
                          {m.thoughts.map((t, idx) => (
                            <li key={idx} className={t.startsWith('-') ? 'list-none -ml-4 font-normal text-blue-700' : 'font-semibold'}>
                              {t}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="prose prose-sm md:prose-base max-w-none prose-p:leading-relaxed prose-pre:bg-gray-800 prose-pre:text-gray-100 prose-headings:font-bold prose-a:text-blue-600 prose-strong:text-gray-900">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
              
              {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
                <div className="mt-2 border-t pt-2 w-full max-w-[90%]">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1">Sources</span>
                  <div className="flex flex-wrap gap-1">
                    {m.citations.map((cit: any) => (
                      <button 
                        key={cit.id}
                        onClick={() => handleCitationClick(cit.id, m.id)}
                        className="text-xs bg-white border border-gray-200 text-blue-600 px-2 py-1 rounded shadow-sm hover:bg-blue-50 transition"
                      >
                        [{cit.id} p{cit.page}]
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          {isLoading && messages[messages.length-1]?.role !== 'assistant' && (
             <div className="text-sm text-gray-500 animate-pulse">Thinking...</div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="p-4 border-t border-gray-100 bg-white">
          <div className="flex bg-gray-50 border border-gray-200 rounded-lg focus-within:ring-2 ring-blue-500 overflow-hidden">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your documents..."
              className="flex-1 p-3 bg-transparent text-sm focus:outline-none text-gray-800"
              disabled={isLoading}
            />
            <button 
              type="submit" 
              className="px-4 text-blue-600 font-medium hover:bg-gray-100 transition disabled:opacity-50"
              disabled={isLoading || !input.trim()}
            >
              Send
            </button>
          </div>
        </form>
      </div>

      {/* Main Panel: PDF Viewer */}
      <div className="w-full md:w-2/3 bg-gray-200 relative h-[50vh] md:h-full overflow-hidden">
        {pdfUrl ? (
          <Worker workerUrl={`https://unpkg.com/pdfjs-dist@3.4.120/build/pdf.worker.min.js`}>
            <Viewer
              fileUrl={pdfUrl}
              plugins={[defaultLayoutPluginInstance, highlightPluginInstance]}
            />
          </Worker>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400">
            <p>Loading document or no documents uploaded...</p>
          </div>
        )}
      </div>
    </div>
  );
}
