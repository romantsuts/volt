import { useState, useContext, Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./App.css";
import LoadingScreen from "./screens/LoadingScreen";
import StartScreen from "./screens/StartScreen";
import MatchStatsScreen from "./screens/MatchStatsScreen";
import GameScreen from "./screens/GameScreen";
import CoinGameSettings from "./layout/CoinGameSettings";
import RatingGameSettings from "./layout/RatingGameSettings";
import FriendGameSettings from "./layout/FriendGameSettings";
import BotGameSettings from "./layout/BotGameSettings";
import NotFoundScreen from "./screens/NotFoundScreen";
import ProfileScreen from "./screens/ProfileScreen";
import LoginScreen from "./screens/LoginScreen";
import RegisterScreen from "./screens/RegisterScreen";
import GameBoards from "./layout/GameBoards";
import AvatarsScreen from "./screens/AvatarsScreen";
import LeaderboardsScreen from "./screens/LeaderboardScreen";
import ForgotPasswordScreen from "./screens/ForgotPasswordScreen";
import ResetPasswordScreen from "./screens/ResetPasswordScreen";
import SettingsScreen from "./screens/SettingsScreen";
import MatchHistoryScreen from "./screens/MatchHistoryScreen";
import PositionEditorPage from "./layout/PositionEditorPage";
import AnalizeScreenMode from "./analizer/AnilizeScreenMode";
import MainScreen from "./screens/MainScreen";
import VoltPlusScreen from "./screens/VoltPlusScreen";
import SupportScreen from "./screens/SupportScreen";
import CoinShop from "./screens/CoinShopScreen";
import PrivacyScreen from "./screens/docs/PrivacyScreen";
import TermsScreen from "./screens/docs/TermsScreen";
import CookiesScreen from "./screens/docs/CookiesScreen";
import TournamentRoomScreen from "./screens/TournamentRoomScreen";
import TournamentResultScreen from "./screens/TournamentResultScreen";
import SystemMaintenanceGate from "./components/SystemMaintenanceGate";
import AnalyticsConsentGate from "./components/AnalyticsConsentGate";

import BoardPreview from "./screens/BoardPreview"; // DELETE

import { AuthProvider, useAuth } from "./context/AuthContext";
import { MatchProvider } from "./context/MatchContext";

const AdminPanel = lazy(() => import("./screens/AdminPanel"));

const ADMIN_ROUTE = import.meta.env.VITE_ADMIN_ROUTE || "/volt-panel";

const ProtectedRoute = ({ children }) => {
  const { user } = useAuth();
  if (!user) {
    // Если пользователя нет в контексте, отправляем на логин
    return <Navigate to="/login" replace />;
  }
  return children;
};

function App() {
  return (
    <BrowserRouter>
    <AnalyticsConsentGate />
      {/* AuthProvider снаружи: MatchProvider читает userProfile через useAuth() */}
      <AuthProvider>
        <SystemMaintenanceGate>
          <MatchProvider>
            <Routes>
              <Route path="/login" element={<LoginScreen />} />
              <Route path="/register" element={<RegisterScreen />} />
              <Route path="/forgot-password" element={<ForgotPasswordScreen />} />
              <Route path="/reset-password" element={<ResetPasswordScreen />} />
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <Suspense fallback={<LoadingScreen />}>
                      <StartScreen />
                    </Suspense>
                  </ProtectedRoute>
                }
              >
              <Route index element={<MainScreen />} />
              <Route path="match-history" element={<MatchHistoryScreen />} />
              <Route path="tournaments" element={<TournamentRoomScreen />} />
              <Route path="tournaments/:id" element={<TournamentRoomScreen />} />
              <Route path="tournaments/:tournamentId/matches/:matchId/games/:gameNumber" element={<TournamentResultScreen />} />
              <Route path={ADMIN_ROUTE} element={
                  <Suspense fallback={<LoadingScreen />}>
                      <AdminPanel />
                  </Suspense>
              } />
              <Route path="boards" element={<GameBoards />} />
              <Route path="avatars" element={<AvatarsScreen />} />
              <Route path="leaderboard" element={<LeaderboardsScreen />} />
              <Route path="/rating-game-settings" element={<RatingGameSettings />} />
              <Route path="/coin-game-settings" element={<CoinGameSettings />} />
              <Route path="/friend-game-settings" element={<FriendGameSettings />} />
              <Route path="/bot-game-settings" element={<BotGameSettings />} />
              <Route path="/profile-page" element={<ProfileScreen />} />
              <Route path="volt-plus" element={<VoltPlusScreen />} />
              <Route path="/coinsshop" element={<CoinShop />} />
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="/support" element={<SupportScreen />} />
            </Route>
            
            <Route path="/preview" element={<BoardPreview />} />
            <Route path="/privacy" element={<PrivacyScreen />} />
            <Route path="/terms" element={<TermsScreen />} />
            <Route path="/cookies" element={<CookiesScreen />} />
            <Route path="*" element={<NotFoundScreen />} />
            
            
            <Route path="/game/:gameType/:roomId" element={<ProtectedRoute><GameScreen /></ProtectedRoute>} />
            <Route path="/game" element={<ProtectedRoute><GameScreen /></ProtectedRoute>} />
            
            {/* <Route path="/results" element={<ProtectedRoute><MatchStatsScreen /></ProtectedRoute>} /> */}
            <Route path="/results/:gameType/:roomId/:winner" element={<ProtectedRoute><MatchStatsScreen /></ProtectedRoute>} />
            
            <Route path="/editor" element={<ProtectedRoute><PositionEditorPage /></ProtectedRoute>} />
            <Route path="/match-history/match-analize/:id" element={<ProtectedRoute><AnalizeScreenMode /></ProtectedRoute>} />
            </Routes>
          </MatchProvider>
        </SystemMaintenanceGate>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
