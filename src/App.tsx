import { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { Worker, Viewer } from '@react-pdf-viewer/core';
import { searchPlugin } from '@react-pdf-viewer/search';
import { UploadCloud, Search, FileText, X } from 'lucide-react';
import clsx from 'clsx';

// Import styles
import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/search/lib/styles/index.css';

// Import pdf.js worker from the installed package
import packageJson from '../package.json';
const pdfjsVersion = packageJson.dependencies['pdfjs-dist'].replace('^', '');

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string>('');
  const [searchText, setSearchText] = useState<string>('');
  
  // Initialize the search plugin
  const searchPluginInstance = searchPlugin({
    keyword: searchText,
  });
  const { highlight, clearHighlights } = searchPluginInstance;

  // Cleanup ObjectURL when file changes
  useEffect(() => {
    return () => {
      if (fileUrl) {
        URL.revokeObjectURL(fileUrl);
      }
    };
  }, [fileUrl]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles && acceptedFiles.length > 0) {
      const pdfFile = acceptedFiles[0];
      setFile(pdfFile);
      setFileUrl(URL.createObjectURL(pdfFile));
      setSearchText('');
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
  });

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchText(value);
    
    if (value.trim() === '') {
        clearHighlights();
    } else {
        highlight(value);
    }
  };

  const clearSearch = () => {
      setSearchText('');
      clearHighlights();
  };

  return (
    <div className="h-screen w-full flex flex-col items-center justify-center p-6 box-border overflow-hidden">
      
      {/* Upload View (Empty State) */}
      {!fileUrl && (
        <div className="animate-in fade-in zoom-in duration-500 max-w-2xl w-full flex flex-col items-center">
            <h1 className="text-5xl font-semibold text-white mb-4 tracking-tight">
              PDF Phrase Hunter
            </h1>
            <p className="text-gray-400 text-xl mb-12 font-light">
              Simple, fast, and secure local PDF search.
            </p>

            <div
              {...getRootProps()}
              className={clsx(
                'w-full aspect-[16/9] rounded-3xl border border-dashed transition-all duration-300 flex flex-col items-center justify-center cursor-pointer backdrop-blur-xl',
                isDragActive 
                  ? 'border-blue-500 bg-blue-500/10 scale-[1.02]' 
                  : 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20'
              )}
            >
              <input {...getInputProps()} />
              <div className="p-6 rounded-full bg-white/5 mb-6 text-white/50">
                  <UploadCloud size={48} strokeWidth={1.5} />
              </div>
              <span className="text-2xl font-medium text-white mb-2">Drop PDF file here</span>
              <span className="text-gray-400">or click to browse</span>
            </div>
        </div>
      )}

      {/* Viewer View (App Interface) */}
      {fileUrl && (
        <div className="w-full h-full max-w-[1400px] flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-8 duration-500">
            
            {/* Toolbar - Floating Glass Bar */}
            <div className="h-16 shrink-0 rounded-2xl bg-[#1c1c1e]/80 backdrop-blur-xl border border-white/10 flex items-center px-4 justify-between shadow-2xl z-20">
                {/* File Info */}
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center text-blue-400">
                        <FileText size={20} strokeWidth={2} />
                    </div>
                    <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium text-white truncate max-w-[200px]">{file?.name}</span>
                        <button 
                            onClick={() => { setFile(null); setFileUrl(''); }}
                            className="text-xs text-gray-500 hover:text-white text-left transition-colors"
                        >
                            Close File
                        </button>
                    </div>
                </div>

                {/* Search Bar - macOS Spotlight Style */}
                <div className="flex-1 max-w-xl mx-4 relative group">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-white transition-colors" size={18} />
                    <input
                        type="text"
                        placeholder="Search phrase..."
                        value={searchText}
                        onChange={handleSearch}
                        className="w-full h-10 bg-black/20 border border-transparent focus:border-blue-500/50 rounded-xl pl-10 pr-10 text-white placeholder-gray-500 focus:outline-none focus:bg-black/40 transition-all font-light"
                    />
                    {searchText && (
                        <button 
                            onClick={clearSearch}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white p-0.5 rounded-full hover:bg-white/10 transition-all"
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>

                {/* Right Placeholder (e.g., zoom controls could go here) */}
                <div className="w-[150px] flex justify-end">
                    {/* Future controls */}
                </div>
            </div>

            {/* Viewer Container - Floating Window */}
            <div className="flex-1 rounded-2xl overflow-hidden bg-[#1c1c1e] border border-white/10 shadow-2xl relative">
                <Worker workerUrl={`https://unpkg.com/pdfjs-dist@${pdfjsVersion}/build/pdf.worker.min.js`}>
                    <div className="absolute inset-0 overflow-y-auto">
                        <Viewer
                            fileUrl={fileUrl}
                            plugins={[searchPluginInstance]}
                            theme="dark"
                            defaultScale={1.2}
                        />
                    </div>
                </Worker>
            </div>
        </div>
      )}

      {/* Global Styles for PDF Viewer Overrides to match Apple Design */}
      <style>{`
        /* Hide default toolbar if it appears (we made our own) */
        .rpv-core__inner-page {
          background-color: transparent !important;
          margin-bottom: 2rem !important;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06) !important;
        }
        
        /* Highlight Color - Apple Yellow */
        .rpv-search__highlight {
            background-color: rgba(255, 214, 10, 0.4) !important; 
            outline: 2px solid rgba(255, 214, 10, 0.8);
            border-radius: 4px;
        }

        /* Current Match Highlight - Apple Orange */
        .rpv-search__highlight--current {
            background-color: rgba(255, 159, 10, 0.5) !important;
            outline: 2px solid rgba(255, 159, 10, 1);
            z-index: 10;
        }
      `}</style>
    </div>
  );
}

export default App;