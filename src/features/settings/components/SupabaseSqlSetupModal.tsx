import React from 'react';
import { Database, ChevronDown, ChevronUp, Copy, Check, Code2 } from 'lucide-react';

interface SupabaseSqlSetupModalProps {
  showAdvancedTools: boolean;
  setShowAdvancedTools: (val: boolean) => void;
  showSqlPreview: boolean;
  setShowSqlPreview: (val: boolean) => void;
  copiedSql: boolean;
  handleCopySql: () => void;
  sqlScript: string;
}

export const SupabaseSqlSetupModal: React.FC<SupabaseSqlSetupModalProps> = ({
  showAdvancedTools,
  setShowAdvancedTools,
  showSqlPreview,
  setShowSqlPreview,
  copiedSql,
  handleCopySql,
  sqlScript,
}) => {
  return (
    <div className="p-4 bg-bg-surface">
      <button
        type="button"
        onClick={() => setShowAdvancedTools(!showAdvancedTools)}
        className="flex items-center justify-between w-full text-xs font-medium text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <Database className="w-3.5 h-3.5 text-accent-primary" />
          <span>SQL Schema & Realtime Setup</span>
        </span>
        {showAdvancedTools ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {showAdvancedTools && (
        <div className="mt-3.5 space-y-3 pt-3 border-t border-border-subtle animate-in fade-in duration-150">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-text-muted">
              Jalankan skrip ini di SQL Editor dashboard Supabase Anda jika membuat project baru.
            </p>
            <button
              type="button"
              onClick={handleCopySql}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all shadow-xs cursor-pointer ${
                copiedSql
                  ? 'bg-status-success text-white'
                  : 'bg-bg-primary hover:bg-bg-hover text-text-primary border border-border-default'
              }`}
            >
              {copiedSql ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-accent-primary" />
                  <span>Copy SQL</span>
                </>
              )}
            </button>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowSqlPreview(!showSqlPreview)}
              className="flex items-center gap-1.5 text-xs text-accent-primary hover:underline py-1 cursor-pointer"
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>{showSqlPreview ? 'Hide SQL Script' : 'View SQL Script'}</span>
            </button>

            {showSqlPreview && (
              <pre className="mt-2 p-3 bg-bg-primary border border-border-subtle rounded-lg text-[11px] font-mono text-text-secondary overflow-x-auto max-h-56 leading-relaxed select-all">
                {sqlScript}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
