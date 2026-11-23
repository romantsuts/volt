import {useRef, useState, useEffect} from "react";
import { useNavigate, Outlet, useLocation } from 'react-router-dom';
import { useMatch } from "../context/MatchContext";
import ActiveGameBanner from "../layout/ActiveGameBanner";
import Header from "../components/Header";
import CookieConsent from "../components/CookieConsent";
import DailyBonus from "../components/DailyBonus";
import { BoardIcon } from "../icons/svgIcons";
import { LayoutGrid, User, SlidersVertical, History, Trophy, Swords, ShieldCheck, Handbag } from "lucide-react"
import { api } from "../services/api";


function StartScreen() {
  const { activeGameAlert } = useMatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [isAdmin, setIsAdmin] = useState(false);
  const ADMIN_ROUTE = import.meta.env.VITE_ADMIN_ROUTE || "/volt-panel";
  const isAdminRoute =
    location.pathname === ADMIN_ROUTE || location.pathname.startsWith(`${ADMIN_ROUTE}/`);
  useEffect(() => {
    let mounted = true;
    api.adminMe()
      .then(({ isAdmin: accessGranted }) => { if (mounted) setIsAdmin(Boolean(accessGranted)); })
      .catch(() => { if (mounted) setIsAdmin(false); });
    return () => { mounted = false; };
  }, []);

  console.log(api);

  if (isAdminRoute && isAdmin === null) return null;
  if (isAdminRoute) {
    // Не-админ: голый Outlet, внутри AdminPanel отрисует NotFoundScreen на весь экран
    // Если нужно админу сделать целиком убрать !isAdmin
    return <Outlet />;
  }

  return (
    
    <div className="flex-1 flex flex-col min-h-screen">
      
      <Header />

      {activeGameAlert && <ActiveGameBanner alertActive={ activeGameAlert } />}

      <div className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 pb-26 md:pb-0 flex flex-col md:flex-row gap-6 ">
          <nav id="side-left-nav" className="glass-card sticky top-20 left-0 right-0 w-full md:fixed md:bottom-auto md:top-32 md:left-auto md:right-auto md:w-20 md:min-h-[580px] p-2.5 md:py-6 rounded-2xl md:rounded-3xl border-b border-x border-white/10 md:border flex md:flex-col justify-around md:justify-start items-center gap-2 md:gap-4 z-30 shadow-xl">



              
              {/* Home / Dashboard */}
              <button
                onClick={() => navigate("/")}
                className={`relative group p-3.5 rounded-2xl transition-all duration-300 flex items-center justify-center ${
                  location.pathname === '/'
                    ? 'bg-gradient-to-tr from-cyan-500/30 via-purple-600/30 to-pink-500/30 text-cyan-300 border border-cyan-400/50 shadow-neon-cyan'
                    : 'text-slate-400 hover:text-cyan-300 hover:bg-white/5 border border-transparent'
                }`}
                title="Dashboard"
              >
                <LayoutGrid className="w-6 h-6" />
                <span className="absolute left-full ml-3 px-2 py-1 bg-slate-900/90 text-cyan-300 text-xs font-mono rounded-md border border-cyan-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block z-50">
                  Панель управления
                </span>
              </button>

              {/* Match History */}
              <button
                onClick={() => navigate('/match-history')}
                className={`relative group p-3.5 rounded-2xl transition-all duration-300 flex items-center justify-center ${
                  location.pathname === '/match-history'
                    ? 'bg-gradient-to-tr from-cyan-500/30 via-purple-600/30 to-pink-500/30 text-purple-300 border border-purple-400/50 shadow-neon-purple'
                    : 'text-slate-400 hover:text-purple-300 hover:bg-white/5 border border-transparent'
                }`}
                title="Match History"
              >
                <History className="w-6 h-6" />
                <span className="absolute left-full ml-3 px-2 py-1 bg-slate-900/90 text-purple-300 text-xs font-mono rounded-md border border-purple-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block z-50">
                  История матчей
                </span>
              </button>

              {/* Leaderboard */}
              <button
                onClick={() => navigate('/leaderboard')}
                className={`relative group p-3.5 rounded-2xl transition-all duration-300 flex items-center justify-center ${
                  location.pathname === '/leaderboard'
                    ? 'bg-gradient-to-tr from-cyan-500/30 via-purple-600/30 to-pink-500/30 text-amber-300 border border-amber-400/50 shadow-[0_0_20px_rgba(251,191,36,0.3)]'
                    : 'text-slate-400 hover:text-amber-300 hover:bg-white/5 border border-transparent'
                }`}
                title="Leaderboard"
              >
                <Trophy className="w-6 h-6" />
                <span className="absolute left-full ml-3 px-2 py-1 bg-slate-900/90 text-amber-300 text-xs font-mono rounded-md border border-amber-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block z-50">
                  Таблица лидеров
                </span>
              </button>

              {/* Tournaments */}
              <button
                onClick={() => navigate('/tournaments')}
                className={`relative group p-3.5 rounded-2xl transition-all duration-300 flex items-center justify-center ${
                  location.pathname.startsWith('/tournaments')
                    ? 'bg-gradient-to-tr from-cyan-500/30 via-purple-600/30 to-pink-500/30 text-emerald-300 border border-emerald-400/50 shadow-neon-cyan'
                    : 'text-slate-400 hover:text-emerald-300 hover:bg-white/5 border border-transparent'
                }`}
                title="Tournaments"
              >
                <Swords className="w-6 h-6" />
                <span className="absolute left-full ml-3 px-2 py-1 bg-slate-900/90 text-emerald-300 text-xs font-mono rounded-md border border-emerald-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block z-50">
                  Турниры
                </span>
              </button>

              {isAdmin && (
                <button
                  onClick={() => navigate(`${ADMIN_ROUTE}?section=tournaments`)}
                  className={`relative group p-3.5 rounded-2xl transition-all duration-300 flex items-center justify-center ${
                    location.pathname.startsWith(ADMIN_ROUTE)
                      ? "bg-cyan-400/15 text-cyan-200 border border-cyan-300/40"
                      : "text-slate-400 hover:text-cyan-200 hover:bg-white/5 border border-transparent"
                  }`}
                  title="Админ-панель"
                >
                  <ShieldCheck className="w-6 h-6" />
                  <span className="absolute left-full ml-3 px-2 py-1 bg-slate-900/90 text-cyan-200 text-xs font-mono rounded-md border border-cyan-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block z-50">
                    Админ-панель
                  </span>
                </button>
              )}

              {/* Choice of Board */}
              <button
                onClick={() => navigate('/boards')}
                className={`relative group p-3.5 rounded-2xl transition-all duration-300 hidden md:flex items-center justify-center ${
                  location.pathname === '/boards'
                    ? 'bg-gradient-to-tr from-cyan-500/30 via-purple-600/30 to-pink-500/30 text-cyan-300 border border-cyan-400/50 shadow-neon-cyan'
                    : 'text-slate-400 hover:text-cyan-300 hover:bg-white/5 border border-transparent'
                }`}
                title="Choice of Board"
              >
                <BoardIcon className="w-6 h-6" />
                <span className="absolute left-full ml-3 px-2 py-1 bg-slate-900/90 text-cyan-300 text-xs font-mono rounded-md border border-cyan-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block z-50">
                  Оформление доски
                </span>
              </button>

              {/* Avatar Selection */}
              <button
                onClick={() => navigate("/avatars")}
                className={`relative group p-3.5 rounded-2xl transition-all duration-300 hidden md:flex items-center justify-center ${
                  location.pathname === 'avatars'
                    ? 'bg-gradient-to-tr from-cyan-500/30 via-purple-600/30 to-pink-500/30 text-pink-300 border border-pink-400/50 shadow-neon-pink'
                    : 'text-slate-400 hover:text-pink-300 hover:bg-white/5 border border-transparent'
                }`}
                title="Avatar Selection"
              >
                <User className="w-6 h-6" />
                <span className="absolute left-full ml-3 px-2 py-1 bg-slate-900/90 text-pink-300 text-xs font-mono rounded-md border border-pink-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block z-50">
                  Аватары
                </span>
              </button>

              <div className="hidden md:block w-8 h-[1px] bg-white/10 my-2"></div>

              {/* Settings */}
              <button
                onClick={() => navigate("/settings")}
                className={`relative group p-3.5 rounded-2xl transition-all duration-300 flex items-center justify-center md:mt-auto ${
                  location.pathname === '/settings'
                    ? 'bg-gradient-to-tr from-cyan-500/30 via-purple-600/30 to-pink-500/30 text-cyan-300 border border-cyan-400/50 shadow-neon-cyan'
                    : 'text-slate-400 hover:text-cyan-300 hover:bg-white/5 border border-transparent'
                }`}
                title="Settings"
              >
                <SlidersVertical className="w-6 h-6" />
                <span className="absolute left-full ml-3 px-2 py-1 bg-slate-900/90 text-cyan-300 text-xs font-mono rounded-md border border-cyan-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block z-50">
                  Меню и настройки
                </span>
              </button>
            </nav>
            <main className="flex-1 flex flex-col relative md:pl-[104px]">
                <Outlet />
            </main>
      </div>

      {/* BONUS MOBILE */}
            <div className="fixed bottom-0 left-0 right-0 z-50 block md:hidden 
            p-6 pb-[calc(1.8rem+env(safe-area-inset-bottom))] 
            bg-slate-950/80 backdrop-blur-xl 
            border-t border-purple-500/20 
            shadow-[0_-10px_25px_rgba(168,85,247,0.15)] animate-fade-in-up"
            >
                <div className="flex items-center justify-between gap-2">
                    <DailyBonus />
                    <button 
                      type="button" 
                      onClick={() => navigate("/coinsshop")} 
                      className="p-4 px-5 md:px-4 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono text-xs font-bold uppercase tracking-wider transition-all duration-200 active:scale-95 flex items-center gap-1.5 shadow-[0_0_10px_rgba(245,158,11,0.1)] hover:border-amber-400"
                    > 
                      <Handbag className="w-4 h-4 md:w-3.5 md:h-3.5" /> 
                      <span >Купить монеты</span> 
                    </button>
                </div>  
            </div>

      {/* GLOBAL FOOTER TELEMETRY */}
          <footer className="mt-auto border-t border-white/5 py-4 px-6 text-center text-xs font-mono text-slate-500 flex flex-col sm:flex-row items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
              <span>BACKGAMMON VOLT // ENGINE v4.8.2-HIGH-TECH</span>
            </div>
            <div className="flex items-center gap-4 text-[11px]">
              <span className="hover:text-cyan-300 cursor-pointer">TERMS OF COMBAT</span>
              <span>•</span>
              <span className="hover:text-cyan-300 cursor-pointer">QUANTUM SECURITY</span>
              <span>•</span>
              <button
                type="button"
                onClick={() => navigate("/support")}
                className="cursor-pointer transition-colors hover:text-cyan-300"
              >
                SUPPORT PROTOCOL
              </button>
            </div>
          </footer>

          <CookieConsent />
    </div>
  );
}

export default StartScreen;
