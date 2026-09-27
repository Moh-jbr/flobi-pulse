import { useEffect } from 'react';
import { useStore, setState, getState, navigate } from './lib/store.js';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';
import Inspector from './components/Inspector.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import RecapSheet from './components/RecapSheet.jsx';
import Toasts from './components/Toasts.jsx';
import Tooltips from './components/Tooltips.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import SignIn from './views/SignIn.jsx';
import Overview from './views/Overview.jsx';
import Recent from './views/Recent.jsx';
import Traffic from './views/Traffic.jsx';
import Errors from './views/Errors.jsx';
import Crashes from './views/Crashes.jsx';
import Logs from './views/Logs.jsx';
import Events from './views/Events.jsx';
import Infrastructure from './views/Infrastructure.jsx';
import Database from './views/Database.jsx';
import Frontends from './views/Frontends.jsx';
import Timeline from './views/Timeline.jsx';
import Versions from './views/Versions.jsx';
import Settings from './views/Settings.jsx';
import { Spinner } from './components/ui.jsx';

const VIEWS = { overview: Overview, recent: Recent, traffic: Traffic, errors: Errors, crashes: Crashes, logs: Logs, events: Events, infrastructure: Infrastructure, database: Database, frontends: Frontends, timeline: Timeline, versions: Versions, settings: Settings };
const ORDER = ['overview', 'recent', 'traffic', 'errors', 'crashes', 'logs', 'events', 'infrastructure', 'database', 'frontends'];

function useAppearance(settings) {
  const theme = settings?.appearance?.theme || 'system';
  const glass = settings?.appearance?.glass ?? 0.5;
  const density = settings?.appearance?.density || 'regular';
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const rt = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const apply = () => {
      root.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
      root.dataset.transparency = rt.matches ? 'reduced' : 'normal';
    };
    apply();
    mq.addEventListener('change', apply);
    rt.addEventListener?.('change', apply);
    return () => {
      mq.removeEventListener('change', apply);
      rt.removeEventListener?.('change', apply);
    };
  }, [theme]);
  useEffect(() => {
    // OS 27 transparency control: 0 = clear glass, 1 = heavily tinted
    document.documentElement.style.setProperty('--glass-alpha', String(0.46 + glass * 0.46));
    document.documentElement.dataset.density = density;
  }, [glass, density]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setState((s) => ({ palette: !s.palette }));
      } else if (mod && e.key === ',') {
        e.preventDefault();
        navigate('settings');
      } else if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        navigate(ORDER[Number(e.key) - 1]);
      } else if (e.key === 'Escape' && !typing && getState().inspector && !getState().palette) {
        setState({ inspector: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const info = useStore((s) => s.info);
  const view = useStore((s) => s.nav.view);
  const bridgeError = useStore((s) => s.bridgeError);
  useAppearance(info?.settings);
  useShortcuts();

  if (bridgeError) return <div className="h-full grid place-items-center text-label-2">{bridgeError}</div>;
  if (!ready || !info) {
    return (
      <div className="h-full grid place-items-center drag">
        <Spinner size={22} />
      </div>
    );
  }
  if (info.mode === 'signed-out')
    return (
      <>
        <SignIn info={info} />
        <Tooltips />
        <ContextMenu />
      </>
    );

  const View = VIEWS[view] || Overview;
  return (
    <div className="h-full flex relative">
      <Sidebar />
      <main className="relative flex-1 min-w-0 bg-content">
        <div key={view} className="absolute inset-0 animate-fade">
          <View />
        </div>
        <Toolbar />
      </main>
      <Inspector />
      <CommandPalette />
      <RecapSheet />
      <Toasts />
      <Tooltips />
      <ContextMenu />
    </div>
  );
}
