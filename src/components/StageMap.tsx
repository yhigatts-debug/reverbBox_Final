import React, { useRef, useCallback, useMemo } from 'react';

interface StageMapProps {
  listenerY: number;
  dims: { length: number; width: number };
  onChange: (y: number) => void;
}

const StageMap: React.FC<StageMapProps> = ({ listenerY, dims, onChange }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Calculate the aspect ratio and box dimensions to fit within h-48 (192px)
  const boxStyle = useMemo(() => {
    const maxWidth = 100; // % of container
    const maxHeight = 100; // % of container
    const ratio = dims.width / dims.length;
    
    // Proportional fitting
    if (ratio > 1.2) { // Wide room
      return { width: `${maxWidth}%`, height: `${maxWidth / ratio}%`, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    } else { // Tall or square room
      return { height: `${maxHeight}%`, width: `${maxHeight * ratio * 0.5}%`, top: '0', left: '50%', transform: 'translateX(-50%)' };
    }
  }, [dims.width, dims.length]);

  const updatePos = useCallback((e: React.MouseEvent | MouseEvent) => {
    // We want to detect the relative position WITHIN the room box
    const boxElement = containerRef.current?.querySelector('.room-box') as HTMLElement;
    if (!boxElement) return;

    const boxRect = boxElement.getBoundingClientRect();
    const rawY = (e.clientY - boxRect.top) / boxRect.height;
    
    // Map click to 0.0-1.0 range of the room box
    const clampedY = Math.max(0.01, Math.min(0.99, rawY));
    onChange(clampedY);
  }, [onChange]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center px-1">
        <div className="flex flex-col">
           <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono">Spatial Mapping</h3>
           <span className="text-[8px] text-zinc-600 font-mono italic">Click box to move listener</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[10px] text-emerald-500 font-mono font-bold tracking-tighter">
            {dims.width}m (W)
          </span>
          <span className="text-[10px] text-emerald-500/80 font-mono font-bold tracking-tighter">
            {dims.length}m (L)
          </span>
        </div>
      </div>
      
      <div 
        ref={containerRef}
        className="relative w-full h-48 bg-black/40 rounded-2xl cursor-crosshair group overflow-hidden border border-white/5"
        onMouseDown={(e) => {
            updatePos(e);
            const onMove = (me: MouseEvent) => updatePos(me);
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        }}
      >
        {/* The Room Box */}
        <div 
          className="room-box absolute border border-emerald-500/30 bg-emerald-500/5 shadow-[0_0_30px_rgba(16,185,129,0.05)] transition-all duration-300 ease-out"
          style={boxStyle as React.CSSProperties}
        >
          {/* Internal Grid Lines */}
          <div className="absolute inset-0 opacity-10 pointer-events-none" 
               style={{ backgroundSize: '15px 15px', backgroundImage: 'linear-gradient(to right, #10b981 1px, transparent 1px), linear-gradient(to bottom, #10b981 1px, transparent 1px)' }} />
          
          {/* Performance Area Indicator */}
          <div className="absolute top-0 left-0 w-full h-1 bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]" />
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 text-[7px] text-emerald-500/60 font-black tracking-widest uppercase whitespace-nowrap">
            Sound Source
          </div>

          {/* Listener Dot - Centered horizontally within the room box */}
          <div 
            className="absolute w-5 h-5 bg-emerald-500 rounded-full border-[3px] border-white shadow-[0_0_20px_rgba(16,185,129,0.8)] -translate-x-1/2 -translate-y-1/2 transition-all duration-150 ease-out z-10"
            style={{ left: '50%', top: `${listenerY * 100}%` }}
          />

          <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[7px] text-slate-600 font-black tracking-widest uppercase">
            Rear
          </div>
        </div>

        {/* Outer Container Context Labels */}
        <div className="absolute top-2 right-3 text-[8px] text-slate-700 font-mono font-bold select-none pointer-events-none uppercase">Front</div>
        <div className="absolute bottom-2 right-3 text-[8px] text-slate-700 font-mono font-bold select-none pointer-events-none uppercase">Back</div>
      </div>
    </div>
  );
};

export default StageMap;