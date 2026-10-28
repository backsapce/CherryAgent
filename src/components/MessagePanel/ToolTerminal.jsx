import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { isTerminalAtBottom } from './terminalFollow';

const normalizeTerminalOutput = (value) => String(value || '').replace(/\r?\n/g, '\r\n');

function fitTerminal(terminal, fitAddon) {
  try {
    fitAddon?.fit();
  } catch {
    // xterm can briefly lack renderer dimensions while mounting or resizing.
  }
}

// Follow new output only while the viewport was already at the bottom; once
// the user scrolls up, streaming output must not yank the view back down.
function fitAndFollowTerminal(terminal, fitAddon, wasAtBottom) {
  if (!terminal) return;
  fitTerminal(terminal, fitAddon);
  if (wasAtBottom && terminal.cols > 0 && terminal.rows > 0) {
    try {
      terminal.scrollToBottom();
    } catch {
      // Fitting can race with renderer teardown during unmount.
    }
  }
}

const ToolTerminal = ({ output }) => {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  const previousOutputRef = useRef('');

  useEffect(() => {
    if (!containerRef.current) return;

    const style = getComputedStyle(containerRef.current);
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      disableStdin: true,
      fontFamily: "'SF Mono', 'Fira Code', ui-monospace, monospace",
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 5000,
      theme: {
        background: style.getPropertyValue('--color-bg').trim() || '#0f172a',
        foreground: style.getPropertyValue('--color-text-content').trim() || '#e5e7eb',
        cursor: style.getPropertyValue('--color-text-content').trim() || '#e5e7eb',
        selectionBackground: style.getPropertyValue('--color-accent').trim() || '#a79fdf',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    previousOutputRef.current = '';

    const resizeObserver = new ResizeObserver(() => {
      const wasAtBottom = isTerminalAtBottom(terminalRef.current);
      requestAnimationFrame(() => {
        fitAndFollowTerminal(terminalRef.current, fitAddonRef.current, wasAtBottom);
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      previousOutputRef.current = '';
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const nextOutput = String(output || '');
    const previousOutput = previousOutputRef.current;
    const wasAtBottom = isTerminalAtBottom(terminal);
    const write = (text) => terminal.write(
      normalizeTerminalOutput(text),
      // The write callback runs after xterm parsed the chunk, so the fresh
      // lines exist and scrollToBottom lands on the true tail.
      () => fitAndFollowTerminal(terminal, fitAddonRef.current, wasAtBottom)
    );
    if (nextOutput.startsWith(previousOutput)) {
      write(nextOutput.slice(previousOutput.length));
    } else {
      terminal.reset();
      write(nextOutput);
    }
    previousOutputRef.current = nextOutput;
  }, [output]);

  return <div className="tool-terminal" ref={containerRef} />;
};

export default ToolTerminal;
