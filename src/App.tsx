import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  ShieldAlert, 
  Trophy, 
  CheckCircle2, 
  XCircle, 
  Database, 
  ChevronRight,
  Download,
  AlertTriangle,
  RefreshCw
} from "lucide-react";

import { Question, Participant, Answer } from "./types";
import { QUESTION_BANK } from "./data/questions";
import { 
  storeGet, 
  storeSet, 
  getParticipantKey
} from "./lib/storage";
import { assignQuestionIndices } from "./utils/quiz-helpers";
import { TimerRing } from "./components/QuizUI";

const TIMER_SECONDS = 30;
const QUESTIONS_PER_QUIZ = 30;
const OPTS = ["A", "B", "C", "D"];

// Google Sheets integration helper
// Configure your Google Apps Script URL in a .env file:
// VITE_GOOGLE_SHEETS_WEBAPP_URL=https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec
const GOOGLE_SHEETS_URL = (import.meta.env.VITE_GOOGLE_SHEETS_WEBAPP_URL as string) || "";

async function sendToGoogleSheets(participant: Participant) {
  if (!GOOGLE_SHEETS_URL) {
    console.warn("VITE_GOOGLE_SHEETS_WEBAPP_URL is not set. Google Sheets update skipped.");
    console.log("Participant response payload:", participant);
    return;
  }
  try {
    const formData = new URLSearchParams();
    formData.append("name", participant.name);
    formData.append("email", participant.email);
    formData.append("status", participant.status);
    formData.append("score", String(participant.score));
    formData.append("totalQuestions", String(participant.totalQuestions));
    formData.append("registeredAt", participant.registeredAt);
    formData.append("completedAt", participant.completedAt || "");
    formData.append("terminatedAt", participant.terminatedAt || "");
    formData.append("terminatedReason", participant.terminatedReason || "");

    await fetch(GOOGLE_SHEETS_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: formData.toString()
    });
    console.log("Sync request dispatched to Google Sheets.");
  } catch (error) {
    console.error("Failed to sync response to Google Sheets:", error);
  }
}

export default function App() {
  const [screen, setScreen] = useState<string>("register");
  const [user, setUser] = useState({ name: "", email: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [storageErr, setStorageErr] = useState(false);

  const [participant, setParticipant] = useState<Participant | null>(null);
  const [quizQuestions, setQuizQuestions] = useState<Question[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [timeLeft, setTimeLeft] = useState(TIMER_SECONDS);
  const [showWarning, setShowWarning] = useState(false);
  const [warningMsg, setWarningMsg] = useState("");

  const timerRef = useRef<any>(null);
  const autoAdvRef = useRef<any>(null);
  const violationsRef = useRef(0);
  const participantRef = useRef<Participant | null>(null);
  participantRef.current = participant;

  // Anti-cheat
  useEffect(() => {
    const noCtx = (e: any) => e.preventDefault();
    const noCopy = (e: any) => { 
      e.preventDefault(); 
      if (screen === "quiz") flash("Copying is not allowed during the test."); 
    };
    const noKey = (e: any) => {
      if ((e.ctrlKey || e.metaKey) && ["c", "v", "a", "u", "s", "p"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        if (screen === "quiz") flash("Keyboard shortcuts are disabled during the test.");
      }
      if (e.key === "PrintScreen") { 
        e.preventDefault(); 
        if (screen === "quiz") flash("Screenshots are not allowed."); 
      }
    };
    document.addEventListener("contextmenu", noCtx);
    document.addEventListener("copy", noCopy);
    document.addEventListener("keydown", noKey);
    return () => {
      document.removeEventListener("contextmenu", noCtx);
      document.removeEventListener("copy", noCopy);
      document.removeEventListener("keydown", noKey);
    };
  }, [screen]);

  // Tab switch detection
  useEffect(() => {
    if (screen !== "quiz") return;
    const onVis = () => {
      if (document.hidden) {
        violationsRef.current += 1;
        terminateTest("tab_switch");
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [screen]);

  // Timer logic
  useEffect(() => {
    if (screen !== "quiz") return;
    clearInterval(timerRef.current);
    setTimeLeft(TIMER_SECONDS);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) { 
          clearInterval(timerRef.current); 
          handleTimeUp(); 
          return 0; 
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [qIndex, screen]);

  function flash(msg: string) {
    setWarningMsg(msg);
    setShowWarning(true);
    clearTimeout(autoAdvRef.current);
    autoAdvRef.current = setTimeout(() => setShowWarning(false), 3000);
  }

  const validateForm = () => {
    const e: Record<string, string> = {};
    if (!user.name.trim()) e.name = "Name is required";
    if (!user.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) e.email = "Valid email required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleRegister = async () => {
    if (!validateForm()) return;
    setLoading(true);
    setStorageErr(false);
    const email = user.email.toLowerCase().trim();
    const key = getParticipantKey(email);

    const existing = await storeGet<Participant>(key);

    if (existing) {
      if (existing.status === "completed") {
        setErrors({ email: "One attempt allowed per participant." });
        setLoading(false);
        return;
      }
      if (existing.status === "terminated") {
        setErrors({ email: "Session disqualified." });
        setLoading(false);
        return;
      }
      setUser({ name: existing.name, email: existing.email });
      setParticipant(existing);
      setLoading(false);
      beginQuiz(existing, true);
      return;
    }

    const indices = assignQuestionIndices(email, QUESTION_BANK.length, QUESTIONS_PER_QUIZ);
    const record: Participant = {
      name: user.name.trim(),
      email,
      registeredAt: new Date().toISOString(),
      status: "active",
      questionIndices: indices,
      currentIndex: 0,
      answers: [],
      score: 0,
      totalQuestions: QUESTIONS_PER_QUIZ,
    };
    
    const ok = await storeSet(key, record);
    if (!ok) setStorageErr(true);
    setParticipant(record);
    setLoading(false);
    beginQuiz(record);
  };

  const beginQuiz = (record: Participant, resume = false) => {
    const qs = record.questionIndices.map((i) => QUESTION_BANK[i]);
    setQuizQuestions(qs);
    const startIdx = resume ? (record.currentIndex || 0) : 0;
    setQIndex(startIdx);
    setAnswers(resume ? record.answers || [] : []);
    setChosen(null);
    setRevealed(false);
    
    const updated = { ...record, status: "active" as const, startedAt: record.startedAt || new Date().toISOString() };
    setParticipant(updated);
    storeSet(getParticipantKey(record.email), updated);
    setScreen("quiz");
  };

  const handleTimeUp = () => {
    setRevealed(true);
    const newAnswers = [...answers, { chosen: null, correct: quizQuestions[qIndex].ans, isCorrect: false }];
    setAnswers(newAnswers);
    persistProgress(newAnswers, qIndex);
    autoAdvRef.current = setTimeout(() => advanceQuestion(newAnswers), 1300);
  };

  const handleOptionClick = (idx: number) => {
    if (revealed) return;
    setChosen(idx);
    setRevealed(true);
    clearInterval(timerRef.current);
    const isCorrect = idx === quizQuestions[qIndex].ans;
    const newAnswers = [...answers, { chosen: idx, correct: quizQuestions[qIndex].ans, isCorrect }];
    setAnswers(newAnswers);
    persistProgress(newAnswers, qIndex);
    autoAdvRef.current = setTimeout(() => advanceQuestion(newAnswers), 1300);
  };

  const persistProgress = (newAnswers: Answer[], idx: number) => {
    const p = participantRef.current;
    if (!p) return;
    const updated = { ...p, answers: newAnswers, currentIndex: idx + 1 };
    setParticipant(updated);
    storeSet(getParticipantKey(p.email), updated);
  };

  const advanceQuestion = (finalAnswers: Answer[]) => {
    setChosen(null);
    setRevealed(false);
    const next = qIndex + 1;
    if (next >= quizQuestions.length) {
      finishQuiz(finalAnswers);
      return;
    }
    setQIndex(next);
  };

  const finishQuiz = async (finalAnswers: Answer[]) => {
    const scoreVal = finalAnswers.filter((a) => a.isCorrect).length;
    const p = participantRef.current;
    if (!p) return;
    const updated: Participant = { 
      ...p, 
      status: "completed" as const, 
      score: scoreVal, 
      completedAt: new Date().toISOString(), 
      answers: finalAnswers 
    };
    setParticipant(updated);
    await storeSet(getParticipantKey(p.email), updated);
    setScreen("results");
    
    // Push the responses to Google Sheets asynchronously
    sendToGoogleSheets(updated);
  };

  const terminateTest = async (reason: string) => {
    clearInterval(timerRef.current);
    clearTimeout(autoAdvRef.current);
    const p = participantRef.current;
    if (p) {
      const updated: Participant = { 
        ...p, 
        status: "terminated" as const, 
        terminatedAt: new Date().toISOString(), 
        terminatedReason: reason 
      };
      setParticipant(updated);
      await storeSet(getParticipantKey(p.email), updated);
      setScreen("terminated");
      
      // Push the termination data to Google Sheets
      sendToGoogleSheets(updated);
    } else {
      setScreen("terminated");
    }
  };

  const resetFlow = () => {
    setScreen("register");
    setUser({ name: "", email: "" });
    setErrors({});
    setParticipant(null);
    setQuizQuestions([]);
    setAnswers([]);
    setQIndex(0);
  };

  const scoreVal = participant?.score || 0;
  const pct = Math.round((scoreVal / QUESTIONS_PER_QUIZ) * 100);
  const scoreColor = pct >= 70 ? "#15803d" : pct >= 40 ? "#FF9900" : "#b91c1c";

  return (
    <div className="min-h-screen flex flex-col items-center py-12 px-6 overflow-x-hidden">
      <AnimatePresence>
        {showWarning && (
          <motion.div 
            initial={{ y: -60 }} animate={{ y: 0 }} exit={{ y: -60 }}
            className="fixed top-0 inset-x-0 bg-rose-600 text-white py-4 text-center font-bold z-[1000] shadow-lg shadow-rose-200"
          >
            {warningMsg}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="w-full max-w-4xl relative">
        <AnimatePresence mode="wait">
          {/* Registration Screen */}
          {screen === "register" && (
            <motion.div 
              key="register"
              initial={{ opacity: 0, y: 20 }} 
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex flex-col items-center"
            >
              <div className="flex items-center gap-4 mb-12">
                <div className="bg-aws-navy text-aws-orange p-3 rounded-2xl font-black text-2xl shadow-xl shadow-slate-200">AWS</div>
                <div className="font-display font-extrabold text-2xl tracking-tight text-aws-ink">
                  Cloud Quiz Arena 
                  <small className="block text-slate-400 font-bold text-xs uppercase tracking-widest mt-0.5">Official Competition Portal</small>
                </div>
              </div>
              
              <div className="text-center mb-10 max-w-xl">
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.2 }}
                  className="inline-flex items-center gap-2.5 bg-orange-50 border border-orange-100 text-orange-700 text-[10px] font-black uppercase tracking-[0.2em] px-4 py-2 rounded-full mb-6"
                >
                  <Database size={13} className="animate-pulse" /> Live Competition
                </motion.div>
                <h1 className="text-5xl font-black text-aws-ink leading-[1.1] mb-4">Test Your <span className="text-aws-orange">AWS</span> Expertise</h1>
                <p className="text-slate-500 text-base leading-relaxed">30 questions · 30 seconds each · strictly monitored secure environment</p>
              </div>

              <div className="bg-white p-10 rounded-[32px] border border-slate-100 w-full max-w-xl shadow-[0_32px_64px_-16px_rgba(0,0,0,0.06)]">
                <div className="bg-indigo-50/50 border border-indigo-100/50 rounded-2xl p-6 mb-8">
                  <div className="text-indigo-900 font-black text-[10px] uppercase tracking-[0.15em] mb-4 flex items-center gap-2.5"><ShieldAlert size={15} className="text-indigo-600"/> Competition Protocols</div>
                  <ul className="text-indigo-800/80 text-[13px] font-medium space-y-3">
                    <li className="flex gap-3"><span className="text-indigo-300">●</span> Tab switching results in immediate disqualification.</li>
                    <li className="flex gap-3"><span className="text-indigo-300">●</span> Copy-pasting and screenshots are strictly disabled.</li>
                    <li className="flex gap-3"><span className="text-indigo-300">●</span> One valid attempt permitted per participant.</li>
                  </ul>
                </div>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Full Identity</label>
                    <input 
                      className="w-full bg-slate-50 border-2 border-slate-50 rounded-2xl px-5 py-4 outline-none focus:bg-white focus:border-aws-orange transition-all font-medium placeholder:text-slate-300"
                      value={user.name} onChange={(e) => setUser({ ...user, name: e.target.value })} placeholder="e.g. Suman Dev" 
                    />
                    {errors.name && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-rose-600 text-[11px] mt-2 font-bold flex items-center gap-1.5"><AlertTriangle size={12}/> {errors.name}</motion.div>}
                  </div>
                  <div className="space-y-2">
                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Official Email</label>
                    <input 
                      className="w-full bg-slate-50 border-2 border-slate-50 rounded-2xl px-5 py-4 outline-none focus:bg-white focus:border-aws-orange transition-all font-medium placeholder:text-slate-300"
                      type="email" value={user.email} onChange={(e) => setUser({ ...user, email: e.target.value })} placeholder="you@organization.com" 
                    />
                    {errors.email && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-rose-600 text-[11px] mt-2 font-bold flex items-center gap-1.5"><AlertTriangle size={12}/> {errors.email}</motion.div>}
                  </div>
                </div>

                <button 
                  className="w-full bg-aws-orange text-aws-ink font-black py-5 rounded-[20px] mt-10 hover:shadow-xl hover:shadow-orange-100 active:scale-[0.98] transition-all flex items-center justify-center gap-3 group text-lg" 
                  onClick={handleRegister} 
                  disabled={loading}
                >
                  {loading ? (
                    <RefreshCw className="animate-spin" size={20}/>
                  ) : (
                    <>Start Test <ChevronRight size={22} className="group-hover:translate-x-1 transition-transform"/></>
                  )}
                </button>
              </div>
            </motion.div>
          )}

          {/* Quiz Arena */}
          {screen === "quiz" && quizQuestions.length > 0 && (
            <motion.div 
              key="quiz"
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }}
              className="w-full max-w-2xl mx-auto py-6"
            >
              <div className="flex items-center justify-between mb-10">
                <div className="space-y-1">
                  <div className="text-aws-orange font-black text-[11px] uppercase tracking-[0.2em] flex items-center gap-2">
                    <div className="w-2 h-2 bg-aws-orange rounded-full animate-pulse"></div> Session Active
                  </div>
                  <h2 className="text-3xl font-black tracking-tight">Question {qIndex + 1} <span className="text-slate-300 font-bold text-xl ml-1">/ {quizQuestions.length}</span></h2>
                </div>
                <TimerRing seconds={timeLeft} total={TIMER_SECONDS} />
              </div>

              <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden mb-12 shadow-inner">
                <motion.div 
                  className="h-full bg-aws-orange shadow-[0_0_12px_rgba(255,153,0,0.4)]" 
                  initial={{ width: 0 }} 
                  animate={{ width: `${((qIndex + (revealed ? 1 : 0)) / quizQuestions.length) * 100}%` }}
                  transition={{ duration: 0.8, ease: "circOut" }}
                />
              </div>

              <AnimatePresence mode="wait">
                <motion.div 
                  key={qIndex}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="bg-white border border-slate-100 p-12 rounded-[40px] shadow-[0_40px_80px_-24px_rgba(0,0,0,0.06)] mb-8"
                >
                  <div className="text-slate-300 font-black text-[10px] uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                    <Database size={14}/> Cloud Infrastructure
                  </div>
                  <div className="text-2xl font-extrabold text-aws-ink leading-[1.4] tracking-tight">{quizQuestions[qIndex].q}</div>
                </motion.div>
              </AnimatePresence>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {quizQuestions[qIndex].options.map((opt, i) => {
                  let state = "idle";
                  if (revealed) {
                    if (i === quizQuestions[qIndex].ans) state = "correct";
                    else if (i === chosen) state = "wrong";
                  } else if (i === chosen) state = "selected";

                  return (
                    <motion.button 
                      key={i} 
                      whileHover={!revealed ? { scale: 1.02 } : {}}
                      whileTap={!revealed ? { scale: 0.98 } : {}}
                      disabled={revealed}
                      onClick={() => handleOptionClick(i)}
                      className={`
                        p-6 rounded-3xl border-2 text-left text-[15px] font-bold flex items-start gap-5 transition-all relative overflow-hidden
                        ${state === "idle" ? "bg-white border-slate-100 hover:border-aws-orange group" : ""}
                        ${state === "selected" ? "bg-orange-50 border-aws-orange text-orange-900" : ""}
                        ${state === "correct" ? "bg-emerald-50 border-emerald-500 text-emerald-800" : ""}
                        ${state === "wrong" ? "bg-rose-50 border-rose-500 text-rose-800" : ""}
                      `}
                    >
                      <span className={`
                        w-8 h-8 flex items-center justify-center rounded-xl text-[11px] font-black shrink-0 transition-colors
                        ${state === "idle" ? "bg-slate-50 text-slate-400 group-hover:bg-orange-100 group-hover:text-aws-orange" : ""}
                        ${state === "selected" ? "bg-aws-orange text-white" : ""}
                        ${state === "correct" ? "bg-emerald-500 text-white" : ""}
                        ${state === "wrong" ? "bg-rose-500 text-white" : ""}
                      `}>
                        {OPTS[i]}
                      </span>
                      <div className="flex-1 pr-2">{opt}</div>
                      {state === "correct" && <CheckCircle2 size={18} className="text-emerald-500 shrink-0 mt-1" />}
                      {state === "wrong" && <XCircle size={18} className="text-rose-500 shrink-0 mt-1" />}
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          )}

          {/* Results Screen */}
          {screen === "results" && participant && (
            <motion.div 
              key="results"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center py-8"
            >
               <div className="relative w-48 h-48 mb-10">
                 <svg className="w-full h-full transform -rotate-90 filter drop-shadow-xl">
                   <circle cx="96" cy="96" r="80" fill="none" stroke="#f1f5f9" strokeWidth="12" />
                   <motion.circle 
                      cx="96" cy="96" r="80" fill="none" stroke={scoreColor} strokeWidth="12" 
                      strokeDasharray={2 * Math.PI * 80}
                      initial={{ strokeDashoffset: 2 * Math.PI * 80 }}
                      animate={{ strokeDashoffset: 2 * Math.PI * 80 * (1 - pct / 100) }}
                      transition={{ duration: 1.5, ease: "circOut" }}
                      strokeLinecap="round"
                   />
                 </svg>
                 <div className="absolute inset-0 flex flex-col items-center justify-center">
                   <motion.div 
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 1, duration: 0.5 }}
                    className="text-5xl font-black font-display tracking-tighter" 
                    style={{ color: scoreColor }}
                   >
                    {pct}%
                   </motion.div>
                   <div className="text-[11px] font-black text-slate-400 uppercase tracking-widest mt-1">AWS Ready</div>
                 </div>
               </div>

               <motion.h2 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="text-4xl font-black mb-2 text-aws-ink"
               >
                {participant.name}
               </motion.h2>
               <div className="text-aws-orange font-black text-xs uppercase tracking-[0.25em] mb-12 flex items-center gap-3">
                 <div className="w-1.5 h-1.5 bg-aws-orange rounded-full"></div> 
                 Certified Achievement 
                 <div className="w-1.5 h-1.5 bg-aws-orange rounded-full"></div>
               </div>

               <div className="grid grid-cols-3 gap-6 w-full max-w-xl mb-12">
                 {[
                   { label: "Correct", val: participant.score, color: "text-emerald-600", bg: "bg-emerald-50/50" },
                   { label: "Wrong", val: QUESTIONS_PER_QUIZ - participant.score, color: "text-rose-600", bg: "bg-rose-50/50" },
                   { label: "Total", val: QUESTIONS_PER_QUIZ, color: "text-indigo-600", bg: "bg-indigo-50/50" }
                 ].map((stat, i) => (
                   <motion.div 
                    key={i}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.7 + i * 0.1 }}
                    className={`bg-white p-8 rounded-[28px] border border-slate-100 text-center shadow-lg shadow-slate-200/50`}
                   >
                     <div className={`text-3xl font-black ${stat.color}`}>{stat.val}</div>
                     <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2">{stat.label}</div>
                   </motion.div>
                 ))}
               </div>

               <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.2 }}
                className={`p-8 rounded-3xl font-bold text-[15px] max-w-xl w-full text-center border-2 leading-relaxed shadow-sm ${pct >= 70 ? "bg-emerald-50/50 border-emerald-100 text-emerald-800" : "bg-slate-50 border-slate-100 text-slate-600"}`}
               >
                 {pct >= 70 ? (
                   <>Excellent performance. You've demonstrated advanced knowledge of <strong className="text-emerald-900">AWS Cloud</strong> core services and security principles.</>
                 ) : (
                   <>Competent effort. Continue exploring AWS Global Infrastructure and Serverless architectures to bridge the knowledge gap for the next round.</>
                 )}
               </motion.div>

               <div className="flex gap-4 mt-12">
                 <button 
                  className="bg-aws-navy text-white font-black px-12 py-5 rounded-2xl flex items-center gap-3 hover:shadow-xl transition-all active:scale-95 group" 
                  onClick={resetFlow}
                 >
                   Arena Home <Trophy size={18} className="group-hover:rotate-12 transition-transform text-aws-orange"/>
                 </button>
               </div>
            </motion.div>
          )}

          {/* Disqualified Screen */}
          {screen === "terminated" && (
            <motion.div 
              key="terminated"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center text-center max-w-lg mx-auto py-16"
            >
              <div className="w-24 h-24 bg-rose-50 text-rose-600 flex items-center justify-center rounded-[32px] mb-10 shadow-xl shadow-rose-100">
                <ShieldAlert size={48} />
              </div>
              <h2 className="text-4xl font-black text-aws-ink mb-4">Integrity Breach Detected</h2>
              <p className="text-slate-500 text-lg leading-relaxed mb-12">
                Your session was immediately terminated due to a <strong className="text-rose-600">Protocol Violation</strong> (tab switching or minimization). Security measures are in place to ensure competition fairness.
              </p>
              <button 
                className="bg-aws-ink text-white font-black px-14 py-5 rounded-2xl shadow-xl hover:shadow-slate-300 transition-all active:scale-95" 
                onClick={resetFlow}
              >
                Return to Entrance
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
