import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const normalizeTerminalOutput = (value) => String(value || '').replace(/\r?\n/g, '\r\n');

function fitAndScrollTerminal(terminal, fitAddon) {
  if (!terminal?.element || !fitAddon) return;
  try {
    fitAddon.fit();
    if (terminal.cols > 0 && terminal.rows > 0) {
      terminal.scrollToBottom();
    }
  } catch {
    // xterm can briefly lack renderer dimensions while mounting or resizing.
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
      requestAnimationFrame(() => {
        fitAndScrollTerminal(terminalRef.current, fitAddonRef.current);
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
    if (nextOutput.startsWith(previousOutput)) {
      terminal.write(normalizeTerminalOutput(nextOutput.slice(previousOutput.length)));
    } else {
      terminal.reset();
      terminal.write(normalizeTerminalOutput(nextOutput));
    }
    previousOutputRef.current = nextOutput;
    requestAnimationFrame(() => {
      fitAndScrollTerminal(terminal, fitAddonRef.current);
    });
  }, [output]);

  return <div className="tool-terminal" ref={containerRef} />;
};

export default ToolTerminal;
