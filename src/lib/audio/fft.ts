/** FFT radix-2 en place (réel/imaginaire séparés). n doit être une puissance de 2. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Spectre de magnitude de trames fenêtrées (Hann). Rend une trame par saut de `hop` échantillons. */
export function stftMagnitudes(x: Float32Array, size: number, hop: number, onFrame: (mag: Float64Array, index: number) => void) {
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  const re = new Float64Array(size), im = new Float64Array(size), mag = new Float64Array(size / 2);
  let idx = 0;
  for (let start = 0; start + size <= x.length; start += hop, idx++) {
    for (let i = 0; i < size; i++) { re[i] = x[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    onFrame(mag, idx);
  }
}
