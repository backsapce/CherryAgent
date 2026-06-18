
// Base Icon component with common props
const IconBase = ({ children, width, height, viewBox, className, style, ...props }) => (
  <svg
    width={width}
    height={height}
    viewBox={viewBox}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ transform: 'translateZ(0)', ...style }}
    {...props}
  >
    {children}
  </svg>
);

// Chevron Icons
export const ChevronRight = ({ width = 14, height = 14, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <polyline points="9 18 15 12 9 6" />
  </IconBase>
);

export const ChevronDown = ({ width = 14, height = 14, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <polyline points="6 9 12 15 18 9" />
  </IconBase>
);

export const ChevronLeft = ({ width = 14, height = 14, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <polyline points="15 18 9 12 15 6" />
  </IconBase>
);


// File & Folder Icons
export const Folder = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </IconBase>
);

export const File = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <polyline points="13 2 13 9 20 9" />
  </IconBase>
);

export const FilePlus = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <polyline points="13 2 13 9 20 9" />
    <line x1="12" y1="18" x2="12" y2="12" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </IconBase>
);

export const FileEdit = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </IconBase>
);

export const Copy = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </IconBase>
);

export const Save = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </IconBase>
);

export const FolderPlus = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </IconBase>
);

// Action Icons
export const Plus = ({ width = 20, height = 20, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </IconBase>
);

export const X = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </IconBase>
);

export const Refresh = ({ width = 18, height = 18, className = '', ...props }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className} {...props}>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </IconBase>
);

export const Upload = ({ width = 20, height = 20, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </IconBase>
);

export const Download = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </IconBase>
);

export const Trash = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </IconBase>
);

export const MultiSelect = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M15 17.5l2 2 4-5" />
  </IconBase>
);

// Settings & Configuration Icons
export const Settings = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </IconBase>
);

export const Lock = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </IconBase>
);


// Appearance & Theme Icons
export const Sun = ({ width = 20, height = 20, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </IconBase>
);

export const Moon = ({ width = 20, height = 20, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </IconBase>
);

export const Monitor = ({ width = 20, height = 20, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </IconBase>
);

// Data & Storage Icons
export const UploadCloud = ({ width = 24, height = 24, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </IconBase>
);

export const DownloadCloud = ({ width = 24, height = 24, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </IconBase>
);

export const AlertTriangle = ({ width = 24, height = 24, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </IconBase>
);

export const Bug = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <rect x="8" y="6" width="8" height="14" rx="4" />
    <path d="M8 8H4" />
    <path d="M16 8h4" />
    <path d="M7 13H3" />
    <path d="M17 13h4" />
    <path d="M8 18H5" />
    <path d="M16 18h3" />
    <path d="M9 3l2 3" />
    <path d="M15 3l-2 3" />
  </IconBase>
);

// Language & Globe Icons
export const Globe = ({ width = 16, height = 16, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </IconBase>
);

// Agent & Connection Icons
export const Plug = ({ width = 16, height = 16, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </IconBase>
);

// Cloud & Storage Icons
export const Cloud = ({ width = 16, height = 16, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
  </IconBase>
);

export const HardDrive = ({ width = 16, height = 16, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <line x1="22" y1="12" x2="2" y2="12" />
    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    <line x1="6" y1="16" x2="6.01" y2="16" />
    <line x1="10" y1="16" x2="10.01" y2="16" />
  </IconBase>
);

// User Icon
export const User = ({ width = 16, height = 16, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </IconBase>
);

// Message & Session Icons
export const MessageSquare = ({ width = 48, height = 48, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </IconBase>
);

export const Send = ({ width = 20, height = 20, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </IconBase>
);

export const Stop = ({ width = 20, height = 20, className = '' }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" className={className} style={{ transform: 'translateZ(0)' }}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

// Context budget bar icon (rect, not battery)
export const Battery = ({ width = 22, height = 14, ratio = 0, color = 'currentColor', className = '' }) => (
  <svg width={width} height={height} viewBox="0 0 22 14" fill="none" className={className} style={{ transform: 'translateZ(0)' }}>
    <rect x="0.5" y="1" width="21" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
    <rect x="2" y="2.8" width={Math.max(17 * ratio, 0)} height="8.4" rx="1" fill={color} opacity="0.85" />
  </svg>
);

// Wifi & Offline Icons
export const WifiOff = ({ width = 16, height = 16, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
    <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
    <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
    <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
    <line x1="12" y1="20" x2="12.01" y2="20" />
  </IconBase>
);

// Image & Attachment Icons
export const ImageGenerate = ({ width = 18, height = 18, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <rect x="3" y="5" width="15" height="14" rx="2" ry="2" />
    <circle cx="8.5" cy="10.5" r="1.5" />
    <path d="M4 17l4.5-4.5L12 16l2-2 3 3" />
    <path d="M18 2v4" />
    <path d="M20 4h-4" />
    <path d="M21 8v2" />
    <path d="M22 9h-2" />
  </IconBase>
);

// Loading / Spinner Icon
export const Spinner = ({ width = 16, height = 16, className = '' }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} style={{ transform: 'translateZ(0)' }}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

// Pie Chart icon for context budget
export const PieChart = ({ size = 28, ratio = 0, color = 'currentColor', className = '' }) => {
  const radius = 10;
  const stroke = 3;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ratio);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" className={className} style={{ transform: 'translateZ(0)' }}>
      {/* Background circle */}
      <circle cx={cx} cy={cy} r={radius} stroke="currentColor" strokeWidth={stroke} opacity="0.15" fill="none" />
      {/* Foreground arc */}
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    </svg>
  );
};

// Layers / Skills Icon
export const Layers = ({ width = 16, height = 16, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </IconBase>
);

// Menu / Hamburger Icon
export const Menu = ({ width = 20, height = 20, className = '' }) => (
  <IconBase width={width} height={height} viewBox="0 0 24 24" className={className}>
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </IconBase>
);

// Empty State Icons
