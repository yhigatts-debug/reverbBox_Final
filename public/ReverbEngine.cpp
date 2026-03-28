#include <emscripten.h>
#include <vector>
#include <cmath>
#include <algorithm>
#include <random>
#include <cstring>
#include <ctime>
#include <cstdint>
#include <wasm_simd128.h>

// =========================================================
// 共通ユーティリティ（実機の汚れを再現する物理シミュレータ）
// =========================================================
inline float lexi_quantize(float x) {
    const float q = 262144.0f; // 18bit定点演算の再現
    return std::floor(x * q + 0.5f) / q;
}

inline float lexi_saturate(float x) {
    // 発散防止: 余裕を持たせたリミッター
    // ±1.0のハードクリップは通常動作域でも高調波を生成する
    // APFのgが0.7以下に制御されていればタンク内信号は±2以内に収まる
    // → ±4.0まで線形を維持し、完全なクリップは緊急時のみ
    return std::clamp(x, -4.0f, 4.0f);
}


// =========================================================
// 1. Lexicon 480L — Dattorro "figure-8" アロープスループ構造
//    Dattorro, "Effect Design Part 1" (JAES 1997)
//    Griesinger スタイルの2タンクレッグ実装
// =========================================================
class Lexicon480L {
private:
    // シンプルなディレイバッファ
    struct Delay {
        std::vector<float> b;
        int p, sz;
        void init(int n) { sz = n; b.assign(n + 4, 0.0f); p = 0; }
        void clear() { std::fill(b.begin(), b.end(), 0.0f); p = 0; }
        void write(float x) { b[p] = x; if(++p >= sz) p = 0; }
        float read(int tap) const {
            int i = (p - tap + sz) % sz;
            return b[i];
        }
        // 線形補間読み出し
        float readf(float tap) const {
            int ti = (int)tap;
            float fr = tap - (float)ti;
            int i0 = (p - ti - 1 + sz) % sz;
            int i1 = (p - ti - 2 + sz) % sz;
            return b[i0] * (1.0f - fr) + b[i1] * fr;
        }
    };

    // 変調付きオールパスフィルター
    struct ModAllpass {
        Delay d;
        float lfo;
        void init(int sz) { d.init(sz); lfo = static_cast<float>(std::rand() % 628) * 0.01f; }
        void clear() { d.clear(); lfo = 0.0f; }
        float proc(float in, float g, float mod_spd, float excursion) {
            lfo += mod_spd;
            if (lfo > 6.2832f) lfo -= 6.2832f;  // 2πでラップ: sin()引数爆発防止
            float mod = std::sin(lfo) * excursion;
            float tap = (float)(d.sz - 1) + mod;
            tap = std::max(1.0f, std::min((float)(d.sz - 2), tap));
            float delayed = d.readf(tap);
            float w = lexi_saturate(in + g * delayed);  // 書き込み前にsaturate
            d.write(w);
            return delayed - g * w;
        }
        // 変調なし（入力ディフューザー用）
        float proc_fixed(float in, float g) {
            float delayed = d.read(d.sz - 1);
            float w = lexi_saturate(in + g * delayed);  // 書き込み前にsaturate
            d.write(w);
            return delayed - g * w;
        }
    };

    // --- Dattorro論文の全コンポーネント (44100Hz換算) ---
    // 入力ディフューザー 4段
    ModAllpass apIn[4];  // 210, 159, 562, 410 smp

    // タンクL (左レッグ)
    ModAllpass apL1;     // 996 smp, decay_diffusion_1
    Delay      delL1;    // 6598 smp (pure delay)
    float      lpL;      // damping LPF状態
    float      bmL;      // Bass Mult専用LPF状態
    float      dcL = 0.0f;   // lpL DCブロック用
    float      dcFbL = 0.0f; // fbL DCブロック用（フィードバック循環DC遮断）
    float      dcFbR = 0.0f; // fbR DCブロック用
    ModAllpass apL2;     // 2667 smp, decay_diffusion_2
    Delay      delL2;    // 5512 smp (pure delay, 出力タップ・フィードバック)

    // タンクR (右レッグ)
    ModAllpass apR1;     // 1345 smp, decay_diffusion_1
    Delay      delR1;    // 6249 smp (pure delay)
    float      lpR;      // damping LPF状態
    float      bmR;      // Bass Mult専用LPF状態
    float      dcR = 0.0f; // lpR DCブロック用
    ModAllpass apR2;     // 3936 smp, decay_diffusion_2
    Delay      delR2;    // 4687 smp (pure delay, 出力タップ・フィードバック)


    // プリディレイ
    Delay preDel;
    int preP;
    float bwL;
    float lpfIn;   // 入力ディフューザー低域バイパス用LPF状態

    // 出力EQフィルタ状態変数 (Hi Cut出力LPFのみ)
    float out_lpL = 0.0f, out_lpR = 0.0f;  // 出力LPF (Hi Cut)

    // キャッシュ: 毎サンプルpow()/exp()を排除（ぷつぷつ対策）
    float c_lpf_coef;
    float c_decayL, c_decayR, c_decayL_lo, c_decayR_lo;
    float c_damp, c_bm_coef;  // c_bm_coef: Bass Mult専用LPFカットオフ係数
    float c_dd2L, c_dd2R;
    float c_prevT60, c_prevLocut, c_prevHicut, c_prevBassMult;

public:
    void init(float sr) {
        float s = sr / 29761.0f;  // Dattorro論文は29761Hzベース
        // 入力ディフューザー
        apIn[0].init((int)(142 * s)); apIn[1].init((int)(107 * s));
        apIn[2].init((int)(379 * s)); apIn[3].init((int)(277 * s));
        // タンクL
        apL1.init((int)(672 * s));  delL1.init((int)(4453 * s));
        lpL = 0.0f; dcL = 0.0f; dcFbL = 0.0f; dcFbR = 0.0f;
        apL2.init((int)(1800 * s)); delL2.init((int)(3720 * s));
        // タンクR
        apR1.init((int)(908 * s));  delR1.init((int)(4217 * s));
        lpR = 0.0f; dcR = 0.0f; bmL = 0.0f; bmR = 0.0f;
        apR2.init((int)(2656 * s)); delR2.init((int)(3163 * s));
        // プリディレイ (最大200ms)
        preDel.init((int)(sr * 0.2f)); preP = 0; bwL = 0.0f; lpfIn = 0.0f;
        // キャッシュ初期値（init時に一度計算）
        const float fs0 = 44100.0f;
        c_lpf_coef = 1.0f - std::exp(-6.2832f * 300.0f / fs0);
        c_prevT60 = -1.0f; c_prevLocut = -1.0f; c_prevHicut = -1.0f; c_prevBassMult = -1.0f;
        c_decayL = c_decayR = c_decayL_lo = c_decayR_lo = 0.5f;
        c_damp = 0.5f; c_dd2L = c_dd2R = 0.35f;
    }

    void clear_all() {
        for(int i=0;i<4;i++) apIn[i].clear();
        apL1.clear(); delL1.clear(); apL2.clear(); delL2.clear(); lpL = 0.0f; bmL = 0.0f; dcL = 0.0f; dcFbL = 0.0f; dcFbR = 0.0f;
        apR1.clear(); delR1.clear(); apR2.clear(); delR2.clear(); lpR = 0.0f; bmR = 0.0f; dcR = 0.0f;
        preDel.clear(); bwL = 0.0f; lpfIn = 0.0f;
    }

    void process(float inL, float inR, float& outL, float& outR, float* params) {
        const float fs = 44100.0f;
        const float mod_spd   = (0.5f + params[8] * 1.5f) / fs;
        const float excursion = params[9] * 8.0f;

        // --- decay/damp キャッシュ: pow()/exp()は値が変化した時だけ再計算 ---
        // sv[]スムージングで毎サンプル微変化するとAPFのg係数が揺れて「息づき」が発生する
        const float cur_t60    = params[4];
        const float cur_locut  = params[6];
        const float cur_hicut  = params[7];
        const float cur_bassm  = params[10];
        if (std::abs(cur_t60   - c_prevT60)    > 1e-6f ||
            std::abs(cur_locut - c_prevLocut)   > 1e-6f ||
            std::abs(cur_hicut - c_prevHicut)   > 1e-6f ||
            std::abs(cur_bassm - c_prevBassMult)> 1e-6f) {
            c_prevT60 = cur_t60; c_prevLocut = cur_locut; c_prevHicut = cur_hicut; c_prevBassMult = cur_bassm;
            // RT60校正式 (v19実測7点フィット, 2026-03-11 + 大ホール7.0s補正 2026-03-28)
            // [0.6-1.608s]: use = 0.9507 * t^1.1015
            // [1.608-10s]:  use = 0.9898 * t^1.0165  (7.0s実測6.568s→-9%を補正)
            float _t = std::max(cur_t60, 0.01f);
            float t60 = std::max((_t <= 1.608f)
                        ? 0.9507f * std::pow(_t, 1.1015f)
                        : 0.989848f * std::pow(_t, 1.016545f), 0.05f);
            // decay計算
            const float s44 = fs / 29761.0f;
            const float loopL = (672 + 4453 + 1800 + 3720) * s44;
            const float loopR = (908 + 4217 + 2656 + 3163) * s44;
            const float loopTotal = loopL + loopR;
            float decayTotal = std::clamp(
                std::pow(10.0f, -3.0f * loopTotal / (t60 * fs)), 0.0001f, 0.9999f);
            c_decayL = std::pow(decayTotal, loopL / loopTotal);
            c_decayR = std::pow(decayTotal, loopR / loopTotal);
            c_dd2L = std::clamp(c_decayL + 0.15f, 0.25f, 0.50f);
            c_dd2R = std::clamp(c_decayR + 0.15f, 0.25f, 0.50f);
            // 低域decay（実機480L方式: Bass Multで低域のみを長くする）
            // Bass Mult=1.0→フラット, >1.0→低域RT60延長, <1.0→低域RT60短縮
            float bass_m = std::max(cur_bassm, 0.1f);
            float t60_lo = std::max(t60 * bass_m, 0.05f);
            float decayTotalLo = std::clamp(
                std::pow(10.0f, -3.0f * loopTotal / (t60_lo * fs)), 0.0001f, 0.9999f);
            c_decayL_lo = std::pow(decayTotalLo, loopL / loopTotal);
            c_decayR_lo = std::pow(decayTotalLo, loopR / loopTotal);
            // Bass Mult専用LPFカットオフ: Lo Cut連動（クロスオーバー境界）
            c_bm_coef = 1.0f - std::exp(-6.2832f * params[6] / 44100.0f);
            // damp
            c_damp = 1.0f - std::exp(-6.2832f * cur_hicut / 44100.0f);
        }
        const float decayL   = c_decayL;
        const float decayR   = c_decayR;
        const float decayL_lo= c_decayL_lo;  // 低域用decay（Bass Multで延長）
        const float decayR_lo= c_decayR_lo;
        const float dd1      = 0.70f;
        const float dd2L     = c_dd2L;
        const float dd2R     = c_dd2R;
        const float damp     = c_damp;
        const float bm_coef  = c_bm_coef;    // Bass Mult専用LPF係数
        // --- プリディレイ ---
        preDel.write((inL + inR) * 0.5f);
        int preTap = (int)(params[5] * fs) + 1;
        preTap = std::clamp(preTap, 1, preDel.sz - 1);
        float x = preDel.read(preTap);

        // --- 入力バンド幅フィルター (LPF) ---
        bwL += 0.9995f * (x - bwL);
        x = bwL;

        // --- 入力ディフューザー 4段 ---
        lpfIn += c_lpf_coef * (x - lpfIn);
        float x_lo = lpfIn;
        float x_hi = x - lpfIn;
        x_hi = apIn[0].proc_fixed(x_hi, 0.75f);
        x_hi = apIn[1].proc_fixed(x_hi, 0.75f);
        x_hi = apIn[2].proc_fixed(x_hi, 0.625f);
        x_hi = apIn[3].proc_fixed(x_hi, 0.625f);
        x = x_lo + x_hi;



        // --- タンクL処理 ---
        float rawFbL = delR2.read(delR2.sz - 1);
        float fbL = rawFbL;  // DCブロック除去（clampでDC不発生）
        float tL = x + fbL;
        tL = apL1.proc(tL, dd1, mod_spd, excursion);
        delL1.write(lexi_saturate(tL));
        tL = delL1.read(delL1.sz - 1);
        lpL += damp * (tL - lpL);           // dampingフィルタ（HIGH CUT）
        float lpL_ac = lpL;
        bmL += bm_coef * (tL - bmL);        // Bass Mult専用LPF（200Hz）
        tL = bmL * decayL_lo               // 低域（200Hz以下）= Bass Multで延長
           + (tL - bmL) * decayL;           // 高域（200Hz以上）= RT60通り・固定
        tL = apL2.proc(tL, dd2L, mod_spd * 0.97f, excursion * 0.8f);
        delL2.write(lexi_saturate(tL));

        // --- タンクR処理 ---
        float rawFbR = delL2.read(delL2.sz - 1);
        float fbR = rawFbR;
        float tR = x + fbR;
        tR = apR1.proc(tR, dd1, mod_spd * 1.03f, excursion);
        delR1.write(lexi_saturate(tR));
        tR = delR1.read(delR1.sz - 1);
        lpR += damp * (tR - lpR);           // dampingフィルタ（HIGH CUT）
        float lpR_ac = lpR;
        bmR += bm_coef * (tR - bmR);        // Bass Mult専用LPF（200Hz）
        tR = bmR * decayR_lo               // 低域（200Hz以下）= Bass Multで延長
           + (tR - bmR) * decayR;           // 高域（200Hz以上）= RT60通り・固定
        tR = apR2.proc(tR, dd2R, mod_spd * 1.06f, excursion * 0.8f);
        delR2.write(lexi_saturate(tR));

        // --- 出力タップ (delay線のみ、APF内部バッファは不使用) ---
        const float s44 = 44100.0f / 29761.0f;
        float oL =  delL1.read((int)(266  * s44))
                  + delL1.read((int)(2974 * s44))
                  + delL2.read((int)(1996 * s44))
                  + delR1.read((int)(1990 * s44))
                  + delR2.read((int)(1066 * s44))
                  + delR1.read((int)(187  * s44))
                  + delL2.read((int)(1913 * s44));

        float oR =  delR1.read((int)(353  * s44))
                  + delR1.read((int)(3627 * s44))
                  + delR2.read((int)(2673 * s44))
                  + delL1.read((int)(2111 * s44))
                  + delL2.read((int)(121  * s44))
                  + delL1.read((int)(335  * s44))
                  + delR2.read((int)(1228 * s44));

        // Dry信号 = 入力をそのまま出力（Bricasti/TC6000と同定義）
        // Pre-DelayはWetのみに適用。DryとWetの間隔がPre-Delay。
        // 実機480LはDry=0でコンソール側でMixする前提のため、この定義が正しい。
        float dryL = inL;
        float dryR = inR;

        // 出力EQフィルタ (Hi Cut LPFのみ)
        const float out_lp_coef = 1.0f - std::exp(-6.2832f * params[7] / 44100.0f);
        out_lpL += out_lp_coef * (oL - out_lpL); oL = out_lpL;
        out_lpR += out_lp_coef * (oR - out_lpR); oR = out_lpR;

        outL = (dryL * params[2] + oL * 0.8646f * params[3]) * params[1];
        outR = (dryR * params[2] + oR * 0.8646f * params[3]) * params[1];
    }
};

// =========================================================
// 2. Bricasti M7 独立基板クラス (人格B: 物量投入型)
// =========================================================
class BricastiM7 {
private:
    struct ERTap {
        int pos;
        float gainL;
        float gainR;
    };

    // 1. 初期反射（ER）セクション
    // 【v17】1200タップ均等乱数 → 96タップ指数分布スパース配置
    // 実機M7: 疎な個別反射が聴こえる + L/R非対称 + 指数密度増加
    // 96 = 4の倍数でSIMD効率を維持
    static constexpr int ER_TAPS = 1024;
    std::vector<ERTap> erTable;
    std::vector<int>   erPos;
    std::vector<float> erGainL;
    std::vector<float> erGainR;

    // LFOモジュレーション用（Late金属感解消）
    float lfoPhase;  // 0〜2π

    std::vector<float> preDelay;
    int preP;
    int preDelayLen;

    // 2. 高密度テイル（Late Reverb）セクション：32段の直列ディフューザー
    // Lexiの「面」の拡散に対し、Bricは「点」の集積で密度を作る
    struct Diffuser {
        std::vector<float> b;
        int p;
        int len;
        void init(int sz) {
            b.assign(sz, 0.0f);
            std::memset(b.data(), 0, b.size() * sizeof(float));
            len = sz;
            p = 0;
        }
        void clear() {
            std::memset(b.data(), 0, b.size() * sizeof(float));
            p = 0;
        }
        // 変調をかけず、純粋なオールパスとして極めて高い密度を稼ぐ
        float proc(float in, float g) {
            float out = b[p];
            float v = in + (out * g);
            b[p] = v;
            if (++p >= len) p = 0;
            return out - v * g;
        }
    };

    // Late Reverb: 入力ディフューザー(4段APF) + 純ディレイライン + LPF + クロスフィードバック
    // 【v16】16段直列APF→フラッターエコー発生 → Dattorro型に変更
    // ループ時間10110smp維持でRT60校正を保持
    struct Delay {
        std::vector<float> b; int p; int sz;
        void init(int n) { sz=n; b.assign(n+4, 0.0f); p=0; }
        void clear() { std::fill(b.begin(),b.end(),0.0f); p=0; }
        void write(float x) { b[p]=x; if(++p>=sz) p=0; }
        float read(int tap) const { int i=(p-tap+sz)%sz; return b[i]; }
        float readf(float tap) const {
            int ti=(int)tap; float fr=tap-ti;
            int i0=(p-ti-1+sz)%sz, i1=(p-ti-2+sz)%sz;
            return b[i0]*(1.0f-fr)+b[i1]*fr;
        }
    };
    Diffuser diffL[4], diffR[4]; // 入力ディフューザー4段
    // FDN: 4本DL、互いに素
    // 2143+2377+2663+2927=10110smp @44100Hz
    Delay fdn[8];
    float lpf[8];      // 各ライン末端LPF
    float lpErL = 0.0f, lpErR = 0.0f;  // ER出力LPF (V-Roll)
    float erInSmL = 0.0f, erInSmR = 0.0f; // ER→FDN注入スムージング
    float out_lpL = 0.0f, out_lpR = 0.0f;  // 出力LPF (Hi Cut)

public:
    void init(float sr) {
        float s = sr / 44100.0f;
        
        // 【v17】96タップ指数分布スパースER
        // 実機M7: 疎な個別反射 + L/R非対称 + 指数密度増加 + 正負混在
        erTable.clear(); erPos.clear(); erGainL.clear(); erGainR.clear();
        std::mt19937 genL(1337), genR(2719); // L/R別シード → 完全非対称
        std::uniform_real_distribution<float> dJitter(-0.05f, 0.05f);
        std::uniform_real_distribution<float> dSign(-1.0f, 1.0f);
        const float posMin = 441.0f, posMax = 2311.0f; // 10ms〜52ms @44100Hz (FDN最短52msと接続)
        float sumGL = 0.0f, sumGR = 0.0f;
        preDelayLen = static_cast<int>(24000 * s);  // posクランプに必要なので先に計算
        for(int i = 0; i < ER_TAPS; i++) {
            float t = static_cast<float>(i) / (ER_TAPS - 1);
            float basePos = posMin * std::pow(posMax / posMin, t); // 指数分布
            int posL = std::clamp(static_cast<int>(basePos * (1.0f + dJitter(genL)) * s), 1, preDelayLen - 1);
            int posR = std::clamp(static_cast<int>(basePos * (1.0f + dJitter(genR)) * s), 1, preDelayLen - 1);
            float decay = std::exp(-t * 3.0f); // 指数減衰ゲイン
            float gL = (dSign(genL) > 0.0f ? 1.0f : -1.0f) * decay; // 正負混在
            float gR = (dSign(genR) > 0.0f ? 1.0f : -1.0f) * decay;
            erTable.push_back({ posL, gL, gR });
            erPos.push_back(posL);
            erGainL.push_back(gL); erGainR.push_back(gR);
            sumGL += std::abs(gL); sumGR += std::abs(gR);
        }
        float normL = 1.0f / std::max(sumGL, 1e-6f);
        float normR = 1.0f / std::max(sumGR, 1e-6f);
        for(int i = 0; i < ER_TAPS; i++) {
            erGainL[i] *= normL; erGainR[i] *= normR;
            erTable[i].gainL = erGainL[i]; erTable[i].gainR = erGainR[i];
        }
        lfoPhase = 0.0f;

        preDelayLen = static_cast<int>(24000 * s);
        preDelay.assign(preDelayLen * 2, 0.0f);
        preP = 0;

        // 入力ディフューザー4段: 合計778smp @44100Hz (ループ10110smpのうち拡散に充当)
        // 互いに素な長さでER後の密度を稼ぐ
        int dLens[] = { 149, 211, 197, 221 };
        for(int i=0; i<4; i++) {
            diffL[i].init(static_cast<int>(dLens[i] * s));
            diffR[i].init(static_cast<int>((dLens[i]+7) * s)); // L/Rを素数差7で非同期化
        }
        // FDN 4本DL初期化
        int fdnLens[] = { 2311, 3491, 4801, 6143, 7559, 9001, 10613, 12007 };
        for(int i=0; i<8; i++) fdn[i].init(static_cast<int>(fdnLens[i] * s));
        for(int i=0; i<4; i++) lpf[i]=0.0f;
        lpErL=0.0f; lpErR=0.0f;
        erInSmL=0.0f; erInSmR=0.0f;
    }

    void clear_all() {
        std::memset(preDelay.data(), 0, preDelay.size() * sizeof(float));
        preP = 0;
        for(int i=0; i<8; i++) { fdn[i].clear(); }
        for(int i=0; i<4; i++) { diffL[i].clear(); diffR[i].clear(); }
        for(int i=0; i<8; i++) lpf[i]=0.0f;
        lpErL=0.0f; lpErR=0.0f;
    }

    void process(float inL, float inR, float& outL, float& outR, float* params) {
        // HTML IDs: params[4]: RT60, params[7]: HIGH CUT, params[13]: DENSITY, params[14]: ROOM SIZE, params[15]: V-ROLL
        
        // 1. 入力をPreDelayへ (ID 5 考慮)
        // ★ 書き込みはER読み出しの後 → 最短タップでも現在フレームを読まない
        float monoIn = (inL + inR) * 0.5f;

        // 【配線】パラメータ制御
        float erSize = std::max(params[14], 0.1f); // ID 14: ROOM SIZE (0だとDry直結になるため下限0.1)
        // ID 13: DENSITY → FDN注入量と出力ミックス比を制御（音量ではなく密度）
        // Density=0: ER直接成分のみ（疎、個別反射が聞こえる）
        // Density=1: FDN最大注入（密、高密度テイル）
        float density = std::clamp(params[13], 0.0f, 1.0f);
        float erLevel = 1.0f; // ER積和スケールは固定（Wet Gainで音量制御）

        // 2. ER算出：1200タップの積和演算 (SIMD並列化)
        v128_t vErL = wasm_f32x4_splat(0.0f);
        v128_t vErR = wasm_f32x4_splat(0.0f);
        
        // 【修正1行目】Pre-DelayバッファからID 5（params[5]）に基づいて読み出し位置を決定
        int rP = (preP - static_cast<int>(params[5] * 44100.0f) + preDelayLen * 2) % preDelayLen;
        const float* pdBase = &preDelay[rP + preDelayLen];
        
        const int* pPos = &erPos[0];
        const float* pGL = &erGainL[0];
        const float* pGR = &erGainR[0];


        // Density: 有効ERタップ数を12〜96本で制御（4の倍数）
        // 少ない→疎な個別反射、多い→高密度テイル。RT60無関係。
        const int minTaps = 16;
        const int activeTaps = minTaps + (int)(density * (ER_TAPS - minTaps));
        const int activeTaps4 = (activeTaps / 4) * 4; // 4の倍数に丸める

        for(int i = 0; i < activeTaps4; i += 4) {
            v128_t val = wasm_f32x4_make(
                pdBase[-static_cast<int>(pPos[i]   * erSize)],
                pdBase[-static_cast<int>(pPos[i+1] * erSize)],
                pdBase[-static_cast<int>(pPos[i+2] * erSize)],
                pdBase[-static_cast<int>(pPos[i+3] * erSize)]
            );
            vErL = wasm_f32x4_add(vErL, wasm_f32x4_mul(val, wasm_v128_load(&pGL[i])));
            vErR = wasm_f32x4_add(vErR, wasm_f32x4_mul(val, wasm_v128_load(&pGR[i])));
        }

        // 各タップゲインはinit()で96本総和=1に正規化済み
        // tapNorm不要: 本数が減っても各ゲインはそのまま使う
        float erL = (wasm_f32x4_extract_lane(vErL,0)+wasm_f32x4_extract_lane(vErL,1)+
                     wasm_f32x4_extract_lane(vErL,2)+wasm_f32x4_extract_lane(vErL,3)) * erLevel;
        float erR = (wasm_f32x4_extract_lane(vErR,0)+wasm_f32x4_extract_lane(vErR,1)+
                     wasm_f32x4_extract_lane(vErR,2)+wasm_f32x4_extract_lane(vErR,3)) * erLevel;

        // 3. Late Reverb: 4×4 FDN (v18)
        // 旧: 1本長いDL(9332smp) → ループ周期191msの連打エコー
        // 新: 4本短いDL(最長66ms) × ハダマール行列フィードバック → エコーなし
        // ループ合計10110smp維持 → RT60校正式(v10)をそのまま流用
        const float bric_loop_len = 10110.0f; // 未使用（各ライン個別計算）
        const float bric_fs = 44100.0f;
        // RT60校正式 (v19実測7点フィット, 2026-03-11)
        // [0.8-1.608s]: use = 7.2313 * t^1.7210
        // [1.608-6.3s]: use = 4.4326 * t^1.1716  (誤差±2%以内)
        // RT60: 各FDNライン個別rt_fb（独立フィードバック設計）
        // UIと実測が1:1で一致する。クロスフィードバックなし。
        // 密度はER 1024タップで担保。
        // RT60校正式（FDNライン長変更後、LFO=Off マーカー直読 新3+新4平均で安定化）
        // 実測誤差: UI=1.608s→-0.4%, UI=3.0s→-1.2%（測定誤差±2%内、確定）
        // t60_bric_sec = 0.906423 * UI^1.188744
        float t60_bric_sec = std::clamp(
            0.906423f * std::pow(params[4], 1.188744f),
            0.05f, 12.0f);
        // FDN ライン長4倍: 基音5Hz以下→可聴域ピーク密集→キーン音解消
        const float fdnLens_f[8] = { 2311.0f, 3491.0f, 4801.0f, 6143.0f, 7559.0f, 9001.0f, 10613.0f, 12007.0f };
        // ハダマール行列を正しく機能させるため全ライン同一rt_fb（平均ライン長で計算）
        const float fdnLenMean = (2311.0f+3491.0f+4801.0f+6143.0f+7559.0f+9001.0f+10613.0f+12007.0f) * 0.125f; // 6990.8
        float rt_fb = std::clamp(
            std::pow(10.0f, -3.0f * fdnLenMean / (t60_bric_sec * bric_fs)),
            0.0001f, 0.9000f); // 上限0.90: 高rt_fbでの発振・キーン音防止
        float rt_fb_arr[8];
        for(int i=0; i<8; i++) rt_fb_arr[i] = rt_fb;

        // FDN末端ダンピング: V-Roll (params[15]) を使用
        // V-Roll = FDNテイルの高域ロールオフ（実機M7の動作に準拠）
        float cutHz  = params[15];
        float lpCoef = 1.0f - std::exp(-6.2832f * cutHz / 44100.0f);
        lpCoef = std::clamp(lpCoef, 0.01f, 0.98f);

        // ER出力はフィルタなしで直接使用
        float erL_f = erL;
        float erR_f = erR;

        // Density: 0→ディフューザーg最小（疎、サウンド密度低）、1→最大（密）
        // diff_gの基底をrt_fbから算出し、Densityで0.25〜0.70にスケール
        // diff_g上限を0.85に引き上げ: フラッターエコー解消に必要な拡散量
        // diff_g上限0.75: g=0.92では群遅延108msでDrumが遅くなる
        const float diff_g_base = std::clamp(rt_fb * 0.5f + 0.30f, 0.45f, 0.75f);
        const float diff_g = 0.25f + density * (diff_g_base - 0.25f);

        // LFO: 4本独立変調で金属音分散
        // 各ラインを異なる速度・位相で変調 → コムフィルターが分散
        lfoPhase += 0.7f / 44100.0f * 6.2832f;
        if (lfoPhase > 6.2832f) lfoPhase -= 6.2832f;

        // FDN注入: diff_g=0.75での安全スケール（APF後ピーク≈0.016, steady≦20で安全）
        float inDiffL = erL * 1.0f;
        float inDiffR = erR * 1.0f;
        for(int i=0; i<4; i++) {
            inDiffL = diffL[i].proc(inDiffL, diff_g);
            inDiffR = diffR[i].proc(inDiffR, diff_g);
        }

        // FDN各ラインの末端を読み出す
        // LFO: 8本、L/R対称、2速度（常時ON、測定用トグル削除）
        const float lfoDepth = 32.0f;
        const float lfoPhases[8] = {
            lfoPhase,         lfoPhase,         // fdn[0,1] L,R 同位相
            lfoPhase*1.13f,   lfoPhase*1.13f,   // fdn[2,3] L,R
            lfoPhase*1.27f,   lfoPhase*1.27f,   // fdn[4,5] L,R
            lfoPhase*1.41f,   lfoPhase*1.41f    // fdn[6,7] L,R
        };
        float v[8];
        for(int i=0; i<8; i++) {
            float modF = std::sin(lfoPhases[i]) * lfoDepth;
            float tap = std::clamp((float)(fdn[i].sz - 1) + modF, 1.0f, (float)(fdn[i].sz - 2));
            v[i] = fdn[i].readf(tap);
            lpf[i] += lpCoef * (v[i] - lpf[i]);
            v[i] = lpf[i];
        }

        // H8 Hadamard フィードバック (正規化済み 1/sqrt(8))
        const float hs = 1.0f / 2.8284f;
        const float h0 = (v[0]+v[1]+v[2]+v[3]+v[4]+v[5]+v[6]+v[7])*hs;
        const float h1 = (v[0]-v[1]+v[2]-v[3]+v[4]-v[5]+v[6]-v[7])*hs;
        const float h2 = (v[0]+v[1]-v[2]-v[3]+v[4]+v[5]-v[6]-v[7])*hs;
        const float h3 = (v[0]-v[1]-v[2]+v[3]+v[4]-v[5]-v[6]+v[7])*hs;
        const float h4 = (v[0]+v[1]+v[2]+v[3]-v[4]-v[5]-v[6]-v[7])*hs;
        const float h5 = (v[0]-v[1]+v[2]-v[3]-v[4]+v[5]-v[6]+v[7])*hs;
        const float h6 = (v[0]+v[1]-v[2]-v[3]-v[4]-v[5]+v[6]+v[7])*hs;
        const float h7 = (v[0]-v[1]-v[2]+v[3]-v[4]+v[5]+v[6]-v[7])*hs;
        auto softlim = [](float x) -> float {
            return std::tanh(x * 0.5f) * 2.0f;
        };
        fdn[0].write(softlim(inDiffL + h0 * rt_fb));
        fdn[1].write(softlim(inDiffR + h1 * rt_fb));
        fdn[2].write(softlim(inDiffL + h2 * rt_fb));
        fdn[3].write(softlim(inDiffR + h3 * rt_fb));
        fdn[4].write(softlim(inDiffL + h4 * rt_fb));
        fdn[5].write(softlim(inDiffR + h5 * rt_fb));
        fdn[6].write(softlim(inDiffL + h6 * rt_fb));
        fdn[7].write(softlim(inDiffR + h7 * rt_fb));

        // ステレオ出力ミックス: 偶数→L、奇数→R
        float lateL = (v[0] + v[2] + v[4] + v[6]) * 0.25f;
        float lateR = (v[1] + v[3] + v[5] + v[7]) * 0.25f;

        // Density はdiff_gのみで制御（RT60・音量に影響しない）
        // Late と ER は固定比率でミックス
        // ER を Late の -12dB に設定
        // ER と Late のミックス
        float wetL = (lateL + erL_f * 0.40f) * 52.3655f;
        float wetR = (lateR + erR_f * 0.40f) * 52.3655f;

        // 出力EQフィルタ (Hi Cut LPFのみ)
        const float out_lp_coef = 1.0f - std::exp(-6.2832f * params[7] / 44100.0f);
        out_lpL += out_lp_coef * (wetL - out_lpL); wetL = out_lpL;
        out_lpR += out_lp_coef * (wetR - out_lpR); wetR = out_lpR;

        outL = (inL * params[2] + wetL * params[3]) * params[1];
        outR = (inR * params[2] + wetR * params[3]) * params[1];

        // PreDelayへの書き込みはER読み出し後
        preDelay[preP] = monoIn;
        preDelay[preP + preDelayLen] = monoIn;
        if (++preP >= preDelayLen) preP = 0;
    }
}; // class BricastiM7


// =========================================================
// 3. TC System 6000 基板 (人格C: 精密音場シミュレーター)
// =========================================================
class TC6000 {
private:
    struct Band {
        std::vector<float> b; int p; int len;
        void init(int sz) { b.assign(sz, 0.0f); std::memset(b.data(), 0, b.size()*sizeof(float)); len = sz; p = 0; }
        void clear() { std::memset(b.data(), 0, b.size()*sizeof(float)); p = 0; }
        float proc(float in, float g) {
            float out = b[p]; float v = in + (out * g);
            b[p] = v; if (++p >= len) p = 0;
            return out - v * g;
        }
    };
    // マルチバンド・ネットワーク
    Band lowL[4], lowR[4], midL[4], midR[4], highL[4], highR[4];
    float x_lpL, x_lpR, x_hpL, x_hpR;
    // テイル生成用フィードバック・レジスタ
    float fbL[3], fbR[3]; 

    // 【修正2行目】TC用Pre-Delayバッファとインデックスの追加
    float pBuf[44100]; int pIdx;

public:
    void init(float sr) {
        float s = sr / 44100.0f;
        // APFライン長: 互いに素・広分散（旧: 比率1.15程度 → 新: 比率~2.5でコムフィルター共振を分散）
        // low合計6648smp, mid合計3894smp, high合計1926smp (旧比ほぼ同等, RT60校正への影響軽微)
        int l_lens[] = {1009, 1321, 1871, 2447}, m_lens[] = {563, 743, 1009, 1579}, h_lens[] = {277, 401, 557, 691};
        for(int i=0; i<4; i++) {
            lowL[i].init(l_lens[i]*s); lowR[i].init((l_lens[i]+13)*s);
            midL[i].init(m_lens[i]*s); midR[i].init((m_lens[i]+11)*s);
            highL[i].init(h_lens[i]*s); highR[i].init((h_lens[i]+7)*s);
        }
        x_lpL = x_lpR = x_hpL = x_hpR = 0;
        for(int i=0; i<3; i++) fbL[i] = fbR[i] = 0;
        std::memset(pBuf, 0, sizeof(pBuf)); pIdx = 0;
    }

    void clear_all() {
        for(int i=0; i<4; i++) {
            lowL[i].clear(); lowR[i].clear(); midL[i].clear(); midR[i].clear(); highL[i].clear(); highR[i].clear();
        }
        x_lpL = x_lpR = x_hpL = x_hpR = 0;
        for(int i=0; i<3; i++) fbL[i] = fbR[i] = 0;
        std::memset(pBuf, 0, sizeof(pBuf)); pIdx = 0;
    }

    void process(float inL, float inR, float& outL, float& outR, float* params) {
        // 【修正3行目】入力信号をPre-Delayバッファへ格納し、ID 5（params[5]）に基づいて読み出し
        pBuf[pIdx] = (inL + inR) * 0.5f; 
        int rP = (pIdx - static_cast<int>(params[5] * 44100.0f) + 44100) % 44100;
        float mono = pBuf[rP]; if(++pIdx >= 44100) pIdx = 0;

        // 【修正v9】バンド別ループ長でrt個別計算 → 全バンドが正確なRT60に収束
        // low:  l_lens合計 = 1541+1617+1701+1787 = 6646
        // mid:  m_lens合計 = 881+931+1001+1079  = 3892
        // high: h_lens合計 = 413+473+511+527    = 1924
        const float tc_fs = 44100.0f;
        // RT60校正式 (TC6000, Mid Decay=1.0基準安定測定3点: 1.608s→-1.1%, 3.0s→-0.4%, 7.0s→-0.8%)
        // t60_tc = 0.984552 * UI^1.126438
        float t60_tc = [&](){
            float _t = std::max(params[4], 0.01f);
            return std::max(0.984552f * std::pow(_t, 1.126438f), 0.01f);
        }();
        // 【修正v10】クロスFB(L→R→L)でループが×2になるため実ループ長×2で計算
        // low:6648×2×0.9551=12699, mid:3894×2×0.9551=7439, hi:1926×2×0.9551=3679
        float rtLo   = std::pow(10.0f, -3.0f * 12699.0f / (t60_tc * tc_fs));
        float base_rt = std::pow(10.0f, -3.0f * 7439.0f / (t60_tc * tc_fs));
        float rtHi_base = std::pow(10.0f, -3.0f * 3679.0f / (t60_tc * tc_fs));
        rtLo    = std::clamp(rtLo,    0.0001f, 0.9998f);
        base_rt = std::clamp(base_rt, 0.0001f, 0.9500f);  // 中域発振防止
        rtLo    = std::clamp(rtLo,    0.0001f, 0.9998f);
        base_rt = std::clamp(base_rt, 0.0001f, 0.9500f);  // 中域発振防止
        // HI DAMPING / AIR QUALITY でhighバンドのみ追加減衰
        // AIR QUALITY: params[16]をそのまま使用（max=1.0で減衰なし = 中立）
        float rtHi = rtHi_base * (1.0f - (params[18]/2.0f)) * params[16];
        rtHi = std::clamp(rtHi, 0.0001f, 0.9300f);  // 高域発振防止（大ホールキーン音対策）
        // Lo/Mid Decay Multiplier（実機VSS-4のDecay Multiplier相当）
        // params[19]: Lo Decay Mult（1.0=中立, >1.0→低域RT60延長）
        // params[20]: Mid Decay Mult（1.0=中立, >1.0→中域RT60延長）
        float loMult  = std::max(params[19], 0.1f);
        float midMult = std::max(params[20], 0.1f);
        float t60_lo  = std::max(t60_tc * loMult,  0.05f);
        float t60_mid = std::max(t60_tc * midMult, 0.05f);
        rtLo    = std::clamp(std::pow(10.0f, -3.0f * 12699.0f / (t60_lo  * tc_fs)), 0.0001f, 0.9998f);
        base_rt = std::clamp(std::pow(10.0f, -3.0f *  7439.0f / (t60_mid * tc_fs)), 0.0001f, 0.9500f);

        // 1. バンド分割
        // lowバンド: LOW CUT以下（正しい1次IIR LPF係数）
        const float lp_coef = 1.0f - std::exp(-6.2832f * params[6] / 44100.0f);
        x_lpL += lp_coef * (mono - x_lpL); float low_in = x_lpL;
        x_lpR += lp_coef * (mono - x_lpR);
        // highバンド: HIGH CUT以上
        const float hp_coef = 1.0f - std::exp(-6.2832f * params[7] / 44100.0f);
        x_hpL += hp_coef * (mono - x_hpL); float high_in = mono - x_hpL;
        x_hpR += hp_coef * (mono - x_hpR);
        float mid_in = mono - low_in - high_in;

        // 2. フィードバックループ（実機TC6000準拠: 正規化なし）
        float tLoL = low_in  + fbL[0] * rtLo;
        float tLoR = low_in  + fbR[0] * rtLo;
        float tMiL = mid_in  + fbL[1] * base_rt;
        float tMiR = mid_in  + fbR[1] * base_rt;
        float tHiL = high_in + fbL[2] * rtHi;
        float tHiR = high_in + fbR[2] * rtHi;

        for(int i=0; i<4; i++) {
            tLoL = lowL[i].proc(tLoL, 0.65f); tLoR = lowR[i].proc(tLoR, 0.65f);
            tMiL = midL[i].proc(tMiL, 0.65f); tMiR = midR[i].proc(tMiR, 0.65f);
            tHiL = highL[i].proc(tHiL, 0.65f); tHiR = highR[i].proc(tHiR, 0.65f);
        }
        
        fbL[0] = tLoR; fbR[0] = tLoL; fbL[1] = tMiR; fbR[1] = tMiL; fbL[2] = tHiR; fbR[2] = tHiL;

        // 3. ER/TAIL BALANCE (ID 17)
        float bal = params[17]/2.0f;
        // 【v13.1】inp_scale=(1-rt)変更によりWet Gain再調整要
        float tailL = (tLoL * (1.0f - bal) + tMiL + tHiL * bal);
        float tailR = (tLoR * (1.0f - bal) + tMiR + tHiR * bal);

        // 4. 最終合成
        outL = (inL * params[2] + tailL * 1.2884f * params[3]) * params[1];
        outR = (inR * params[2] + tailR * 1.2884f * params[3]) * params[1];
    }
};

// =========================================================
// 統合シャーシ
// =========================================================
struct Chassis {
    int engineType;
    float params[22];
    float sv[21];
    Lexicon480L lexi;
    BricastiM7  bric;
    TC6000      tc;
} sys;

extern "C" {
    EMSCRIPTEN_KEEPALIVE void prepare(float sr) {
        std::srand(static_cast<unsigned int>(std::time(nullptr)));
        sys.lexi.init(sr);
        sys.bric.init(sr);
        sys.tc.init(sr);
        sys.engineType = 1;
        for(int i=0; i<21; i++) {
            sys.params[i] = 1.0f;
            sys.sv[i] = 1.0f;
        }
        sys.params[1] = 2.000f; // ID 1
        sys.params[2] = 1.000f; // ID 2
        sys.params[3] = 1.500f; // ID 3
        sys.params[4] = 1.608f; // ID 4
        sys.params[5] = 0.053f; // ID 5
        sys.params[6] = 1000.0f; // ID 6
        sys.params[7] = 20000.0f; // ID 7
        sys.params[8] = 0.500f; // ID 8 Spin (UI default: lexSpin=0.5)
        sys.params[9] = 0.300f; // ID 9 Wander (UI default: lexWander=0.3)
        sys.params[10] = 1.000f; // ID 10 Bass Multiplier (1.0=フラット)
        sys.params[13] = 0.500f; // ID 13 Bric Density (UI default: 0.5)
        sys.params[14] = 1.000f; // ID 14 Bric Room Size (UI default: 1.0)
        sys.params[15] = 8000.0f; // ID 15 Bric V-Roll (UI default: 8000)
        sys.params[16] = 0.500f; // ID 16 TC Air Quality (UI default: 0.5)
        sys.params[17] = 0.500f; // ID 17 TC ER/Tail Balance (UI default: 0.5)
        sys.params[18] = 0.500f; // ID 18 TC Hi-Damping (UI default: 0.5)
        sys.params[19] = 1.000f; // ID 19 TC Lo Decay Mult (1.0=中立)
        sys.params[20] = 1.000f; // ID 20 TC Mid Decay Mult (1.0=中立)
        sys.params[21] = 1.000f; // ID 21 Bric LFO On/Off (1=on, 0=off)
    }

    EMSCRIPTEN_KEEPALIVE void setParameter(int id, float v) {
        if (id == 11 || id == 0) {
            sys.engineType = static_cast<int>(v);
            sys.lexi.clear_all();
            sys.bric.clear_all();
            sys.tc.clear_all();
        } else if (id >= 1 && id <= 20) {
            sys.params[id] = v;
        }
    }

    EMSCRIPTEN_KEEPALIVE void processPtr(float* left, float* right, int len) {
        for(int i=0; i<len; i++) {
            for(int j=1; j<=20; j++) {
                sys.sv[j] += 0.005f * (sys.params[j] - sys.sv[j]);
            }
            float oL = 0, oR = 0;
            if (sys.engineType == 2) {
                sys.bric.process(left[i], right[i], oL, oR, sys.sv);
            } else if (sys.engineType == 3) {
                sys.tc.process(left[i], right[i], oL, oR, sys.sv);
            } else {
                sys.lexi.process(left[i], right[i], oL, oR, sys.sv);
            }
            left[i] = oL;
            right[i] = oR;
        }
    }
}