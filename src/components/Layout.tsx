import { useState } from 'react';
import { Outlet, useOutletContext } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import AIChat, { type ChatIncident } from './AIChat';
import { useTheme } from '../context/ThemeContext';
<<<<<<< HEAD

export default function Layout() {
  const { isDark } = useTheme();
  const [isChatOpen, setIsChatOpen]         = useState(false);
  const [chatInitialMsg, setChatInitialMsg] = useState<string | undefined>();

  // openChat is used by child pages (e.g. Incidents "Investigate" button)
  // to pop open the floating AI chat panel with a pre-built prompt.
  const openChat = (initialMessage?: string) => {
    setChatInitialMsg(initialMessage);
    setIsChatOpen(true);
  };
=======

// Pages that need to open the AI chat with a pre-filled message use this context.
// Pass `incident` to make the backend run a targeted RCA on that pod/node.
export type LayoutContext = {
  openChatWithMessage: (msg: string, incident?: ChatIncident) => void;
};

export function useLayoutContext() {
  return useOutletContext<LayoutContext>();
}

export default function Layout() {
  const { isDark } = useTheme();
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInitialMessage, setChatInitialMessage] = useState<string | undefined>(undefined);
  const [chatIncident, setChatIncident] = useState<ChatIncident | undefined>(undefined);

  const openChatWithMessage = (msg: string, incident?: ChatIncident) => {
    setChatInitialMessage(msg);
    setChatIncident(incident);
    setIsChatOpen(true);
  };

  const handleClose = () => {
    setIsChatOpen(false);
    setChatInitialMessage(undefined);
    setChatIncident(undefined);
  };
>>>>>>> 1801054 (Add test file)

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#060a14] text-white' : 'bg-gray-50 text-gray-900'}`}>
      <Sidebar onOpenChat={() => { setChatInitialMessage(undefined); setChatIncident(undefined); setIsChatOpen(true); }} />
      <div className="ml-[240px] transition-all duration-300">
        <Header />
        <main className="p-6">
<<<<<<< HEAD
          <Outlet context={{ openChat }} />
        </main>
      </div>

      {/* Floating AI Chat panel — triggered only from Incidents "Investigate" button */}
      <AIChat
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        initialMessage={chatInitialMsg}
=======
          <Outlet context={{ openChatWithMessage } satisfies LayoutContext} />
        </main>
      </div>

      {/* AI Chat Modal */}
      <AIChat
        isOpen={isChatOpen}
        onClose={handleClose}
        initialMessage={chatInitialMessage}
        incident={chatIncident}
>>>>>>> 1801054 (Add test file)
      />
    </div>
  );
}
