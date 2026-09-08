"use client";

import { Check, Lightbulb, Sparkles, Wand2 } from "lucide-react";
import { useState } from "react";

/**
 * IntelligentDataEntry - A split-form component for AI-assisted data entry.
 * Follows the Japandi "Calm Finances" design with a dark context panel and clean form.
 */
export function IntelligentDataEntry({ createAction }: { createAction?: (formData: FormData) => Promise<{ ok: boolean; error?: string }> }) {
  const [inputValue, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!createAction || loading) return;
    setLoading(true);
    const formData = new FormData(e.currentTarget);
    formData.set("type", "expense"); // Default for this simplified form
    const res = await createAction(formData);
    if (res.ok) {
       setInput("");
       alert("Record Created!");
    } else {
       alert("Error: " + res.error);
    }
    setLoading(false);
  };

  return (
    <section className="bento-card overflow-hidden flex flex-col md:flex-row min-h-[500px]">
      {/* ... [AI Context Panel] ... */}
      <div className="w-full md:w-3/5 p-12 bg-surface-white">
        <div className="mb-10">
          <p className="text-[10px] font-bold text-foreground/30 uppercase tracking-[0.2em] mb-2">New Entry</p>
          <h4 className="font-heading text-2xl text-foreground">Describe the transaction</h4>
        </div>
        <form className="space-y-8" onSubmit={handleSubmit}>
          {/* Natural Language Input */}
          <div className="relative">
            <input 
              name="note"
              type="text" 
              placeholder="e.g. 'Invested $500 in Vanguard S&P 500 ETF'" 
              className="w-full py-5 px-6 bg-background/30 border-2 border-transparent rounded-2xl outline-none focus:bg-surface-white focus:border-accent-green transition-all font-medium text-lg text-foreground placeholder-foreground/20"
              value={inputValue}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="absolute right-6 top-1/2 -translate-y-1/2 text-accent-green flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">AI Sensing</span>
              <Wand2 size={20} className={loading ? "animate-spin" : "animate-pulse"} />
            </div>
          </div>

          {/* Structured Fields (Auto-filled by AI) */}
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="block text-[10px] font-bold text-foreground/40 uppercase tracking-[0.2em]">Amount</label>
              <div className="relative">
                <span className="absolute left-6 top-1/2 -translate-y-1/2 font-bold text-foreground/30">$</span>
                <input 
                  name="amount"
                  type="text" 
                  defaultValue="1,200.00" 
                  className="w-full py-4 pl-10 pr-6 bg-background/20 rounded-xl outline-none focus:bg-surface-white border-2 border-transparent focus:border-foreground/10 font-bold transition-all text-foreground"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="block text-[10px] font-bold text-foreground/40 uppercase tracking-[0.2em]">Category</label>
              <div className="relative">
                <select name="category" className="w-full py-4 px-6 bg-background/20 rounded-xl outline-none appearance-none font-bold text-foreground cursor-pointer">
                  <option value="investment">Investment</option>
                  <option value="lifestyle">Lifestyle</option>
                  <option value="essence">Essence</option>
                </select>
                <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none opacity-40">
                  <Wand2 size={14} />
                </div>
              </div>
            </div>
          </div>

          {/* Confirm Button */}
          <button 
            type="submit"
            disabled={loading}
            className="w-full py-5 bg-foreground text-background rounded-2xl font-bold text-lg shadow-2xl shadow-foreground/20 hover:scale-[1.01] transition-all duration-300 active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50"
          >
            {loading ? <Wand2 size={20} className="animate-spin" /> : <Check size={20} />}
            Confirm & Reconcile
          </button>
        </form>
      </div>
    </section>
  );
}
