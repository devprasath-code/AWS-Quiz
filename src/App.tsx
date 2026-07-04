import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  ShieldAlert, 
  Trophy, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  Database, 
  Lock, 
  Settings,
  ChevronRight,
  LogOut,
  Download,
  Search,
  RefreshCw,
  AlertTriangle
} from "lucide-react";

import { Question, Participant, AdminSettings, Answer } from "./types";
import { QUESTION_BANK } from "./data/questions";
import { 
  storeGet, 
  storeSet, 
  storeListKeys, 
  getParticipantKey, 
  loadAdminSettings,
  PARTICIPANT_PREFIX,
  ADMIN_KEY
} from "./lib/storage";
import { assignQuestionIndices } from "./utils/quiz-helpers";
import { TimerRing, StatusBadge, ConnDot } from "./components/QuizUI";

const TIMER_SECONDS = 30;
const QUESTIONS_PER_QUIZ = 30;
const ADMIN_PASSCODE = "AWS2026ADMIN";
const OPTS = ["A", "B", "C", "D"];

export default function App() {
  const [screen, setScreen] = useState<string>("register");
  const [user, setUser] = useState({ name: "", email: "", college: "", phone: "" });
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
  const [adminSettings, setAdminSettings] = useState<AdminSettings>({ quizLive: false });
  const [showStartModal, setShowStartModal] = useState(false);

  // Cross-tab sync: when a participant registers in one tab,
  // the admin panel in another tab gets notified immediately
  const channelRef = useRef<BroadcastChannel | null>(null);

  // admin
  const [adminPass, setAdminPass] = useState("");
  const [adminErr, setAdminErr] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [adminLoading, setAdminLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const timerRef = useRef<any>(null);
  const autoAdvRef = useRef<any>(null);
  const violationsRef = useRef(0);
  const participantRef = useRef<Participant | null>(null);
  participantRef.current = participant;
  // Stable ref to beginQuiz so polling closure never goes stale
  const beginQuizRef = useRef<(record: Participant, resume?: boolean) => void>(() => {});
  // Guard to prevent double-starting the quiz from polling
  const admissionStartedRef = useRef(false);

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

  // Polling for admission
  useEffect(() => {
    if (screen !== "waiting") return;
    admissionStartedRef.current = false; // reset guard when entering waiting screen
    let active = true;
    const poll = async () => {
      const settings = await loadAdminSettings();
      if (!active) return;
      setAdminSettings(settings);
      const p = participantRef.current;
      if (!p) return;
      const rec = await storeGet<Participant>(getParticipantKey(p.email));
      if (!active) return;
      
      if (rec && (rec.status === "terminated" || rec.status === "completed")) {
        setParticipant(rec);
        setScreen(rec.status);
        return;
      }
      
      // Admit: either quiz is globally live, or this participant was individually admitted
      if ((settings.quizLive || (rec && rec.status === "admitted")) && !admissionStartedRef.current) {
        admissionStartedRef.current = true;
        const updated = rec || p;
        // Use the ref so we always call the latest version of beginQuiz
        beginQuizRef.current(updated);
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { active = false; clearInterval(id); };
  }, [screen]);

  // Cross-tab communication for instant sync
  useEffect(() => {
    // BroadcastChannel for same-origin tabs
    try {
      const bc = new BroadcastChannel("aws-quiz-sync");
      channelRef.current = bc;
      bc.onmessage = () => {
        if (screen === "admin") loadParticipants();
      };
    } catch { /* BroadcastChannel not available */ }

    // localStorage 'storage' event fires when *another* tab writes
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith("participant:") && screen === "admin") {
        loadParticipants();
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("storage", onStorage);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [screen]);

  // Admin polling (reduced from 15s → 3s for faster list updates)
  useEffect(() => {
    if (screen !== "admin") return;
    loadParticipants();
    const id = setInterval(loadParticipants, 3000);
    return () => clearInterval(id);
  }, [screen]);

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
    if (!user.college.trim()) e.college = "College/Organization is required";
    if (!user.phone.trim() || !/^\d{10}$/.test(user.phone)) e.phone = "Valid 10-digit phone required";
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
    const settings = await loadAdminSettings();
    setAdminSettings(settings);

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
      setUser({ name: existing.name, email: existing.email, college: existing.college, phone: existing.phone });
      setParticipant(existing);
      setLoading(false);
      if (existing.status === "active") beginQuiz(existing, true);
      else if (settings.quizLive) beginQuiz(existing);
      else setScreen("waiting");
      return;
    }

    const indices = assignQuestionIndices(email, QUESTION_BANK.length, QUESTIONS_PER_QUIZ);
    const status = settings.quizLive ? "admitted" : "pending";
    const record: Participant = {
      name: user.name.trim(),
      email,
      college: user.college.trim(),
      phone: user.phone.trim(),
      registeredAt: new Date().toISOString(),
      status,
      questionIndices: indices,
      currentIndex: 0,
      answers: [],
      score: 0,
      totalQuestions: QUESTIONS_PER_QUIZ,
    };
    
    const ok = await storeSet(key, record);
    if (!ok) setStorageErr(true);
    // Notify admin tabs about the new registration
    try { channelRef.current?.postMessage("participant-update"); } catch {}
    setParticipant(record);
    setLoading(false);
    if (status === "admitted") {
      setShowStartModal(true);
      setScreen("startModal");
    } else {
      setScreen("waiting");
    }
  };

  const beginQuiz = (record: Participant, resume = false) => {
    const qs = record.questionIndices.map((i) => QUESTION_BANK[i]);
    setQuizQuestions(qs);
    const startIdx = resume ? (record.currentIndex || 0) : 0;
    setQIndex(startIdx);
    setAnswers(resume ? record.answers || [] : []);
    setChosen(null);
    setRevealed(false);
    setShowStartModal(false);
    
    const updated = { ...record, status: "active" as const, startedAt: record.startedAt || new Date().toISOString() };
    setParticipant(updated);
    storeSet(getParticipantKey(record.email), updated);
    setScreen("quiz");
  };
  // Keep the ref in sync with the latest beginQuiz closure
  beginQuizRef.current = beginQuiz;

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
    const updated = { 
      ...p, 
      status: "completed" as const, 
      score: scoreVal, 
      completedAt: new Date().toISOString(), 
      answers: finalAnswers 
    };
    setParticipant(updated);
    await storeSet(getParticipantKey(p.email), updated);
    setScreen("results");
  };

  const terminateTest = async (reason: string) => {
    clearInterval(timerRef.current);
    clearTimeout(autoAdvRef.current);
    const p = participantRef.current;
    if (p) {
      const updated = { 
        ...p, 
        status: "terminated" as const, 
        terminatedAt: new Date().toISOString(), 
        terminatedReason: reason 
      };
      setParticipant(updated);
      await storeSet(getParticipantKey(p.email), updated);
    }
    setScreen("terminated");
  };

  const resetFlow = () => {
    setScreen("register");
    setUser({ name: "", email: "", college: "", phone: "" });
    setErrors({});
    setParticipant(null);
    setQuizQuestions([]);
    setAnswers([]);
    setQIndex(0);
  };

  // Admin logic
  const handleAdminLogin = () => {
    if (adminPass === ADMIN_PASSCODE) {
      setAdminErr("");
      setAdminPass("");
      setScreen("admin");
    } else {
      setAdminErr("Incorrect passcode.");
    }
  };

  async function loadParticipants() {
    setAdminLoading(true);
    const settings = await loadAdminSettings();
    setAdminSettings(settings);
    const keys = await storeListKeys(PARTICIPANT_PREFIX);
    let all: Participant[] = [];
    for (let i = 0; i < keys.length; i += 20) {
      const chunk = keys.slice(i, i + 20);
      const results = await Promise.all(chunk.map((k) => storeGet<Participant>(k)));
      all = all.concat(results.filter((r): r is Participant => r !== null));
    }
    all.sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());
    setParticipants(all);
    setLastRefreshed(new Date());
    setAdminLoading(false);
  }

  const toggleQuizLive = async () => {
    const next = { ...adminSettings, quizLive: !adminSettings.quizLive, updatedAt: new Date().toISOString() };
    setAdminSettings(next);
    await storeSet(ADMIN_KEY, next);
  };

  const admitEmails = async (emails: string[]) => {
    setAdminLoading(true);
    for (const email of emails) {
      const key = getParticipantKey(email);
      const rec = await storeGet<Participant>(key);
      if (rec && rec.status === "pending") {
        rec.status = "admitted";
        await storeSet(key, rec);
      }
    }
    setSelected(new Set());
    await loadParticipants();
  };

  const reAdmit = async (email: string) => {
    const key = getParticipantKey(email);
    const rec = await storeGet<Participant>(key);
    if (rec) {
      rec.status = "admitted";
      delete rec.terminatedReason;
      await storeSet(key, rec);
      await loadParticipants();
    }
  };

  const exportCSV = () => {
    const headers = ["Name", "Email", "College", "Phone", "Status", "Score", "Registered At"];
    const rows = participants.map((p) => [
      p.name, p.email, p.college, p.phone, p.status, p.score, p.registeredAt
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "leaderboard.csv"; a.click();
  };

  const scoreVal = participant?.score || 0;
  const pct = Math.round((scoreVal / QUESTIONS_PER_QUIZ) * 100);
  const scoreColor = pct >= 70 ? "#15803d" : pct >= 40 ? "#FF9900" : "#b91c1c";

  const filteredParticipants = participants.filter((p) => {
    const s = search.toLowerCase();
    return p.name.toLowerCase().includes(s) || p.email.toLowerCase().includes(s) || p.college.toLowerCase().includes(s);
  });

  return (
    <div className="min-h-screen flex flex-col items-center py-12 px-6 overflow-x-hidden">
      <ConnDot error={storageErr} />
      
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Organization</label>
                      <input 
                        className="w-full bg-slate-50 border-2 border-slate-50 rounded-2xl px-5 py-4 outline-none focus:bg-white focus:border-aws-orange transition-all font-medium placeholder:text-slate-300"
                        value={user.college} onChange={(e) => setUser({ ...user, college: e.target.value })} placeholder="Institution" 
                      />
                      {errors.college && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-rose-600 text-[11px] mt-2 font-bold flex items-center gap-1.5"><AlertTriangle size={12}/> {errors.college}</motion.div>}
                    </div>
                    <div className="space-y-2">
                      <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Phone Contact</label>
                      <input 
                        className="w-full bg-slate-50 border-2 border-slate-50 rounded-2xl px-5 py-4 outline-none focus:bg-white focus:border-aws-orange transition-all font-medium placeholder:text-slate-300"
                        value={user.phone} onChange={(e) => setUser({ ...user, phone: e.target.value.replace(/\D/g, "") })} placeholder="10-digit" maxLength={10} 
                      />
                      {errors.phone && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-rose-600 text-[11px] mt-2 font-bold flex items-center gap-1.5"><AlertTriangle size={12}/> {errors.phone}</motion.div>}
                    </div>
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
                    <>Proceed to Arena <ChevronRight size={22} className="group-hover:translate-x-1 transition-transform"/></>
                  )}
                </button>
              </div>

              <div className="mt-12">
                <button 
                  className="text-slate-400 text-xs font-bold uppercase tracking-widest hover:text-aws-ink transition-colors flex items-center gap-2" 
                  onClick={() => setScreen("adminLogin")}
                >
                  <Settings size={14}/> Terminal Access
                </button>
              </div>
            </motion.div>
          )}

          {/* Start Modal — quiz is live, user can begin immediately */}
          {screen === "startModal" && participant && (
            <motion.div
              key="startModal"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center text-center py-20"
            >
              <div className="w-24 h-24 bg-emerald-50 text-emerald-600 flex items-center justify-center rounded-[32px] mb-10 shadow-xl shadow-emerald-100">
                <CheckCircle2 size={48} />
              </div>
              <h2 className="text-4xl font-black text-aws-ink mb-4">You're Admitted!</h2>
              <p className="text-slate-500 text-lg max-w-md mx-auto mb-12">
                Welcome, <span className="text-aws-ink font-bold">{participant.name.split(' ')[0]}</span>! The arena is live and ready for you.
              </p>
              <button
                className="bg-aws-orange text-aws-ink font-black px-14 py-5 rounded-2xl text-lg shadow-xl shadow-orange-100 hover:shadow-orange-200 active:scale-95 transition-all flex items-center gap-3 group"
                onClick={() => beginQuiz(participant)}
              >
                Begin Quiz Now <ChevronRight size={22} className="group-hover:translate-x-1 transition-transform"/>
              </button>
            </motion.div>
          )}

          {/* Waiting Room */}
          {screen === "waiting" && (
            <motion.div 
              key="waiting"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center text-center py-20"
            >
              <div className="relative mb-12">
                <div className="w-24 h-24 border-4 border-slate-100 rounded-full"></div>
                <div className="absolute inset-0 border-4 border-transparent border-t-aws-orange rounded-full animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <Clock size={32} className="text-aws-orange animate-pulse" />
                </div>
              </div>
              <h2 className="text-3xl font-black mb-3">Awaiting Admission</h2>
              <p className="text-slate-500 text-lg max-w-md mx-auto">
                Hi <span className="text-aws-ink font-bold">{user.name.split(' ')[0]}</span>, your identity is verified. The arena opens once the administrator signals the start.
              </p>
              <div className="mt-12 bg-white border border-slate-100 p-8 rounded-3xl w-full max-w-sm text-left shadow-xl">
                <div className="space-y-4">
                  <div className="flex justify-between items-center border-b border-slate-50 pb-4">
                    <span className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">Queue ID</span>
                    <span className="font-mono text-xs font-bold text-slate-600">AWS-2026-{Math.floor(1000 + Math.random() * 9000)}</span>
                  </div>
                  <div className="flex justify-between items-center border-b border-slate-50 pb-4">
                    <span className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">Status</span>
                    <StatusBadge status={participant?.status || "pending"} />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">Gate Status</span>
                    {adminSettings.quizLive 
                      ? <span className="text-emerald-600 font-black text-[10px] uppercase tracking-widest flex items-center gap-1.5">● Open</span>
                      : <span className="text-rose-500 font-black text-[10px] uppercase tracking-widest flex items-center gap-1.5"><Lock size={12}/> Closed</span>
                    }
                  </div>
                </div>
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
                 <button className="bg-white border border-slate-200 text-slate-500 p-5 rounded-2xl hover:bg-slate-50 transition-all">
                   <Download size={20}/>
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

          {/* Admin Login */}
          {screen === "adminLogin" && (
            <motion.div 
              key="adminLogin"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center py-20"
            >
               <div className="flex items-center gap-4 mb-10">
                 <div className="bg-aws-ink text-white p-4 rounded-2xl shadow-xl"><Lock size={24}/></div>
                 <div className="font-display font-black text-2xl tracking-tight">Terminal Authority</div>
               </div>
               <div className="bg-white p-10 rounded-[32px] border border-slate-100 shadow-[0_32px_64px_-16px_rgba(0,0,0,0.1)] w-full max-w-sm">
                  <div className="space-y-3 mb-8">
                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Authentication Key</label>
                    <input 
                      type="password" 
                      className="w-full bg-slate-50 border-2 border-slate-50 rounded-2xl px-5 py-4 outline-none focus:bg-white focus:border-aws-ink transition-all font-mono" 
                      value={adminPass} onChange={(e) => setAdminPass(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAdminLogin()}
                    />
                    {adminErr && <div className="text-rose-600 text-[11px] mt-2 font-bold flex items-center gap-1.5"><AlertTriangle size={12}/> {adminErr}</div>}
                  </div>
                  <button className="w-full bg-aws-ink text-white font-black py-5 rounded-2xl text-lg hover:shadow-2xl transition-all" onClick={handleAdminLogin}>Initialize Panel</button>
               </div>
               <button className="mt-8 text-slate-400 text-xs font-bold uppercase tracking-widest hover:text-aws-ink transition-colors" onClick={() => setScreen("register")}>Cancel Request</button>
            </motion.div>
          )}

          {/* Admin Dashboard */}
          {screen === "admin" && (
            <motion.div 
              key="admin"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="w-full"
            >
              <div className="flex items-center justify-between mb-12">
                <div>
                  <h1 className="text-4xl font-black tracking-tight text-aws-ink">Arena Controller</h1>
                  <div className="text-slate-400 text-xs font-bold uppercase tracking-widest mt-2 flex items-center gap-2">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                    {lastRefreshed ? `Master sync: ${lastRefreshed.toLocaleTimeString()}` : "Synchronizing system data..."}
                  </div>
                </div>
                <div className="flex gap-3">
                  <button className="bg-white border border-slate-100 p-3.5 rounded-2xl hover:shadow-md transition-all text-slate-500" onClick={loadParticipants} title="Sync Data"><RefreshCw size={18} className={adminLoading ? "animate-spin" : ""}/></button>
                  <button className="bg-white border border-slate-100 p-3.5 rounded-2xl hover:shadow-md transition-all text-slate-500" onClick={exportCSV} title="Export Dataset"><Download size={18}/></button>
                  <button className="bg-rose-50 text-rose-600 p-3.5 rounded-2xl hover:bg-rose-100 transition-all" onClick={() => setScreen("register")} title="Terminate Session"><LogOut size={18}/></button>
                </div>
              </div>

              <div className={`flex items-center justify-between p-8 rounded-[32px] border-2 mb-10 transition-all ${adminSettings.quizLive ? "bg-emerald-50/50 border-emerald-100 shadow-xl shadow-emerald-50" : "bg-white border-slate-100 shadow-card"}`}>
                 <div className="flex items-center gap-6">
                   <div className={`w-16 h-16 rounded-2xl flex items-center justify-center text-2xl shadow-sm ${adminSettings.quizLive ? "bg-white text-emerald-600" : "bg-slate-50 text-slate-300"}`}>
                     {adminSettings.quizLive ? <motion.div initial={{scale:0}} animate={{scale:1}}>▶</motion.div> : "⏸"}
                   </div>
                   <div>
                     <div className="font-black text-lg text-aws-ink">{adminSettings.quizLive ? "Arena Portal: OPEN" : "Arena Portal: LOCKED"}</div>
                     <div className="text-slate-400 text-[11px] uppercase tracking-widest font-black mt-0.5">Real-time Admission Control</div>
                   </div>
                 </div>
                 <button 
                   className={`px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest transition-all shadow-lg active:scale-95 ${adminSettings.quizLive ? "bg-rose-600 text-white shadow-rose-200" : "bg-emerald-600 text-white shadow-emerald-200"}`}
                   onClick={toggleQuizLive}
                 >
                   {adminSettings.quizLive ? "Lock Gates" : "Open Gates"}
                 </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
                 {[
                   { label: "Global Users", val: participants.length, icon: Database, color: "text-aws-ink" },
                   { label: "Awaiting", val: participants.filter(p=>p.status==="pending").length, icon: Clock, color: "text-orange-500" },
                   { label: "Certified", val: participants.filter(p=>p.status==="completed").length, icon: Trophy, color: "text-emerald-600" },
                   { label: "Disqualified", val: participants.filter(p=>p.status==="terminated").length, icon: ShieldAlert, color: "text-rose-600" }
                 ].map((stat, i) => (
                   <div key={i} className="bg-white p-7 rounded-[28px] border border-slate-100 shadow-card">
                     <div className="flex items-start justify-between mb-3">
                       <div className={`text-3xl font-black ${stat.color}`}>{stat.val}</div>
                       <stat.icon size={20} className="text-slate-200" />
                     </div>
                     <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</div>
                   </div>
                 ))}
              </div>

              <div className="bg-white rounded-[40px] border border-slate-100 shadow-[0_40px_80px_-24px_rgba(0,0,0,0.06)] overflow-hidden">
                 <div className="p-8 border-b border-slate-50 flex flex-wrap items-center justify-between bg-slate-50/30 gap-6">
                    <div className="relative w-full sm:w-80">
                      <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16}/>
                      <input 
                        className="w-full bg-white border border-slate-100 rounded-2xl py-3 pl-12 pr-5 text-[13px] font-medium focus:border-aws-ink transition-all shadow-sm" 
                        placeholder="Filter participants..."
                        value={search} onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-3 w-full sm:w-auto">
                      <button className="flex-1 sm:flex-none bg-aws-ink text-white text-[11px] font-black uppercase tracking-widest px-6 py-3 rounded-xl shadow-lg shadow-slate-200 disabled:opacity-30 transition-all active:scale-95" disabled={selected.size === 0} onClick={() => admitEmails([...selected])}>Admit ({selected.size})</button>
                    </div>
                 </div>
                 <div className="overflow-x-auto">
                   <table className="w-full text-left text-sm">
                     <thead>
                       <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50/50">
                         <th className="px-8 py-5 w-12"></th>
                         <th className="px-8 py-5">Identified Participant</th>
                         <th className="px-8 py-5">Affiliation</th>
                         <th className="px-8 py-5">Session</th>
                         <th className="px-8 py-5">Proficiency</th>
                         <th className="px-8 py-5">Terminal</th>
                       </tr>
                     </thead>
                     <tbody className="divide-y divide-slate-50">
                       {filteredParticipants.map((p) => (
                         <tr key={p.email} className="hover:bg-slate-50/50 transition-colors group">
                           <td className="px-8 py-5">
                            <input 
                              type="checkbox" 
                              className="w-4 h-4 rounded-lg accent-aws-ink"
                              checked={selected.has(p.email)} 
                              onChange={() => { const s = new Set(selected); if(s.has(p.email)) s.delete(p.email); else s.add(p.email); setSelected(s); }}
                            />
                           </td>
                           <td className="px-8 py-5">
                             <div className="font-bold text-aws-ink">{p.name}</div>
                             <div className="text-[11px] text-slate-400 font-medium">{p.email}</div>
                           </td>
                           <td className="px-8 py-5 text-slate-500 font-semibold">{p.college}</td>
                           <td className="px-8 py-5"><StatusBadge status={p.status}/></td>
                           <td className="px-8 py-5 font-mono font-black text-aws-ink">{p.status === "completed" ? `${p.score}/${QUESTIONS_PER_QUIZ}` : "—"}</td>
                           <td className="px-8 py-5">
                             {p.status === "pending" && <button className="text-indigo-600 font-black text-[11px] uppercase tracking-widest hover:underline" onClick={() => admitEmails([p.email])}>Admit</button>}
                             {p.status === "terminated" && <button className="text-aws-orange font-black text-[11px] uppercase tracking-widest hover:underline" onClick={() => reAdmit(p.email)}>Override</button>}
                           </td>
                         </tr>
                       ))}
                       {filteredParticipants.length === 0 && (
                         <tr>
                           <td colSpan={6} className="px-8 py-20 text-center text-slate-400 font-medium">No system records match your current filter.</td>
                         </tr>
                       )}
                     </tbody>
                   </table>
                 </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
