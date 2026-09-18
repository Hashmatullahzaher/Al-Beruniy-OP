import React, { useState } from 'react';
import { Send, Shield, Lock, CheckCircle, AlertTriangle, ExternalLink, Bot } from 'lucide-react';
import { SIMULATED_TELEGRAM_DIALOG } from '../../data/scenesData';

interface TelegramSimulatorOverlayProps {
  onHighlight3DNodes?: (nodeIds: string[]) => void;
}

export const TelegramSimulatorOverlay: React.FC<TelegramSimulatorOverlayProps> = ({
  onHighlight3DNodes
}) => {
  const [messages, setMessages] = useState(SIMULATED_TELEGRAM_DIALOG.slice(0, 2));
  const [inputText, setInputText] = useState('');
  const [showStepUpModal, setShowStepUpModal] = useState(false);

  const handleSendPrompt = (text: string) => {
    // Add user message
    const userMsg = {
      id: `user-${Date.now()}`,
      sender: 'user' as const,
      timestamp: '10:42 AM',
      text
    };

    if (text.toLowerCase().includes('top three') || text.toLowerCase().includes('top 3')) {
      const botReply = SIMULATED_TELEGRAM_DIALOG[3];
      setMessages((prev) => [...prev, userMsg, botReply]);
      if (onHighlight3DNodes) {
        onHighlight3DNodes(['installments_collections', 'sales_crm', 'financial_engine']);
      }
    } else if (text.toLowerCase().includes('highest collection risk') || text.toLowerCase().includes('risk')) {
      const botReply = SIMULATED_TELEGRAM_DIALOG[5];
      setMessages((prev) => [...prev, userMsg, botReply]);
    } else {
      // Generic governed response
      const botReply = {
        id: `bot-${Date.now()}`,
        sender: 'bot' as const,
        timestamp: '10:43 AM',
        text: `🤖 Request verified via **ABOS Identity Binding (Type A User: Dr. S. Qasimi)**.\n\nExecuting governed Typed Tool on behalf of authorized project role...\n\nResult retrieved from authoritative domain service. Audit record registered.`,
        metadata: { toolName: 'resolve_natural_query()', authLevel: 'normal' as const }
      };
      setMessages((prev) => [...prev, userMsg, botReply]);
    }
  };

  return (
    <div className="pointer-events-auto bg-slate-950/90 backdrop-blur-xl border border-sky-500/40 rounded-3xl p-4 text-white max-w-sm w-full shadow-2xl shadow-sky-950/60 flex flex-col h-[520px]">
      {/* Mobile Frame Header */}
      <div className="flex items-center justify-between border-b border-sky-500/20 pb-3 mb-2">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-sky-500/20 border border-sky-400 flex items-center justify-center text-sky-300">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-1 text-xs font-bold text-white">
              AL-BERUNIY OS Assistant
              <CheckCircle className="w-3.5 h-3.5 text-sky-400 fill-sky-400/20" />
            </div>
            <div className="text-[10px] text-sky-300/80 font-mono">Bound to: Dr. S. Qasimi (Type A)</div>
          </div>
        </div>
        <button
          onClick={() => setShowStepUpModal(true)}
          className="p-1.5 rounded-lg bg-sky-950 border border-sky-500/40 text-sky-300 hover:bg-sky-900 transition"
          title="Inspect Security & Step-Up Auth"
        >
          <Shield className="w-4 h-4" />
        </button>
      </div>

      {/* Security Banner: Username is not Identity */}
      <div className="bg-sky-950/40 border border-sky-500/20 rounded-lg px-2.5 py-1.5 mb-2 text-[10px] text-sky-200 flex items-center justify-between">
        <span className="flex items-center gap-1 font-mono">
          <Lock className="w-3 h-3 text-sky-400" /> Token Bound · Zero DB SQL
        </span>
        <span className="text-[9px] bg-sky-500/20 text-sky-300 px-1.5 py-0.5 rounded font-bold">RBAC Enforced</span>
      </div>

      {/* Chat Messages Log */}
      <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 text-xs mb-3">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 leading-relaxed ${
                m.sender === 'user'
                  ? 'bg-sky-600 text-white rounded-tr-none'
                  : 'bg-slate-900 border border-sky-500/30 text-slate-100 rounded-tl-none'
              }`}
            >
              <div className="whitespace-pre-line text-[11px]">{m.text}</div>

              {m.metadata?.toolName && (
                <div className="mt-2 pt-1.5 border-t border-sky-500/20 text-[9px] font-mono text-sky-300">
                  ⚡ Tool: {m.metadata.toolName}
                </div>
              )}
            </div>
            <span className="text-[9px] text-slate-500 mt-0.5 px-1">{m.timestamp}</span>
          </div>
        ))}
      </div>

      {/* Suggested Quick Prompts */}
      <div className="flex items-center gap-1.5 mb-2 overflow-x-auto pb-1 text-[10px]">
        <button
          onClick={() => handleSendPrompt('Show me the top three.')}
          className="whitespace-nowrap px-2 py-1 rounded-full bg-slate-900 border border-sky-500/40 text-sky-300 hover:bg-sky-900/50 transition font-mono"
        >
          "Show me the top three"
        </button>
        <button
          onClick={() => handleSendPrompt('Which project has the highest collection risk?')}
          className="whitespace-nowrap px-2 py-1 rounded-full bg-slate-900 border border-sky-500/40 text-sky-300 hover:bg-sky-900/50 transition font-mono"
        >
          "Highest collection risk?"
        </button>
      </div>

      {/* Message Input Box */}
      <div className="flex items-center gap-2 border-t border-slate-800 pt-2">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && inputText.trim()) {
              handleSendPrompt(inputText);
              setInputText('');
            }
          }}
          placeholder="Ask AI Core via Telegram..."
          className="flex-1 bg-slate-900/90 border border-sky-500/30 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
        />
        <button
          onClick={() => {
            if (inputText.trim()) {
              handleSendPrompt(inputText);
              setInputText('');
            }
          }}
          className="p-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white transition"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Step-Up Authentication Modal */}
      {showStepUpModal && (
        <div className="absolute inset-0 bg-slate-950/95 rounded-3xl p-5 flex flex-col justify-between border border-sky-400/60 z-20">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-amber-400 text-xs font-bold font-mono">
                <AlertTriangle className="w-4 h-4" /> STEP-UP AUTH REQUIRED
              </div>
              <button
                onClick={() => setShowStepUpModal(false)}
                className="text-slate-400 hover:text-white text-xs"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-200 leading-relaxed mb-3">
              High-risk actions (payment approval, journal posting, payroll release) <b className="text-amber-300">cannot execute directly from Telegram text</b> without cryptographic re-authentication.
            </p>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-[11px] space-y-1.5 font-mono">
              <div className="text-slate-400">Action: <span className="text-white">Approve Contractor IPC #08</span></div>
              <div className="text-slate-400">Amount: <span className="text-emerald-400">AFN 4,200,000</span></div>
              <div className="text-slate-400">Policy: <span className="text-amber-400">Dual-Control Threshold Exceeded</span></div>
            </div>
          </div>

          <div className="space-y-2">
            <button
              onClick={() => {
                alert('Redirecting to secure ABOS Portal with hardware MFA token...');
                setShowStepUpModal(false);
              }}
              className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition"
            >
              Open Secure ABOS Approval Link <ExternalLink className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowStepUpModal(false)}
              className="w-full py-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white text-xs"
            >
              Cancel / Back to Chat
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
