import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  analyserA: AnalyserNode | null;
  analyserB: AnalyserNode | null;
  colorA: string;
  colorB: string;
  labelA: string;
  labelB: string;
}

const Visualizer: React.FC<VisualizerProps> = React.memo(({ analyserA, analyserB, colorA, colorB, labelA, labelB }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const refs = useRef({ analyserA, analyserB, colorA, colorB, labelA, labelB });
  const data = useRef({
    smoothedA: new Float32Array(1024),
    smoothedB: new Float32Array(1024),
    freqData: new Uint8Array(1024)
  });

  useEffect(() => {
    refs.current = { analyserA, analyserB, colorA, colorB, labelA, labelB };
  }, [analyserA, analyserB, colorA, colorB, labelA, labelB]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let animId: number;

    const render = () => {
      animId = requestAnimationFrame(render);

      const { analyserA, analyserB, colorA, colorB, labelA, labelB } = refs.current;
      const { smoothedA, smoothedB, freqData } = data.current;
      const w = canvas.width;
      const h = canvas.height;
      const gh = h - 30;

      // Reset transform and clear
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0a0a0c';
      ctx.fillRect(0, 0, w, h);

      const minLog = Math.log10(20);
      const maxLog = Math.log10(20000);

      const drawSignal = (analyser: AnalyserNode | null, smoothed: Float32Array, color: string, isOutput: boolean) => {
        // Critical Fix: Add thorough null checks for context to prevent browser crash
        if (!analyser || !analyser.context || analyser.context.state !== 'running') return;
        
        try {
          analyser.getByteFrequencyData(freqData);
        } catch (e) { return; }

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = isOutput ? 2.5 : 2.0; 
        ctx.globalAlpha = isOutput ? 1.0 : 0.85; 

        const sf = 0.88;
        for (let i = 0; i < w; i += 4) {
          const freq = Math.pow(10, minLog + (i / w) * (maxLog - minLog));
          const bin = Math.round(freq * analyser.fftSize / analyser.context.sampleRate);
          const val = freqData[bin] || 0;
          
          smoothed[bin] = smoothed[bin] * sf + val * (1 - sf);
          const y = gh - (Math.pow(smoothed[bin] / 255, 0.5) * gh);

          if (Number.isFinite(y)) {
            if (i === 0) ctx.moveTo(i, y);
            else ctx.lineTo(i, y);
          }
        }
        ctx.stroke();

        if (isOutput) {
          ctx.globalAlpha = 0.2;
          ctx.lineWidth = 6;
          ctx.stroke(); 
        }
        ctx.globalAlpha = 1.0;
      };

      // Frequency Grids
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      [100, 1000, 10000].forEach(f => {
        const x = ((Math.log10(f) - minLog) / (maxLog - minLog)) * w;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, gh); ctx.stroke();
      });

      drawSignal(analyserA, smoothedA, colorA, false);
      drawSignal(analyserB, smoothedB, colorB, true);

      // Legend
      ctx.textAlign = 'left';
      ctx.font = 'bold 11px Inter';
      ctx.fillStyle = colorA; ctx.fillRect(20, 20, 8, 8);
      ctx.fillStyle = '#94a3b8'; ctx.fillText(labelA, 35, 28);
      ctx.fillStyle = colorB; ctx.fillRect(20, 40, 8, 8);
      ctx.fillStyle = '#fff'; ctx.fillText(labelB, 35, 48);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <div className="relative w-full h-full bg-[#0a0a0c] rounded-3xl overflow-hidden border border-white/10 shadow-2xl">
      <canvas ref={canvasRef} width={800} height={400} className="w-full h-full block" />
    </div>
  );
});

export default Visualizer;