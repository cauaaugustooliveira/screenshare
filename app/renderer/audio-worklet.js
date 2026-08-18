/* global AudioWorkletProcessor, registerProcessor */

// Recebe ArrayBuffers com float32 intercalado L/R do processo principal.
// A fila é propositalmente pequena: em atraso, descartamos áudio antigo em vez
// de aumentar a latência da chamada.
class TelaPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queuedFrames = 0;

    this.port.onmessage = (event) => {
      const samples = new Float32Array(event.data);
      if (samples.length % 2) return;
      this.queue.push(samples);
      this.queuedFrames += samples.length / 2;

      while (this.queuedFrames > sampleRate * 2 && this.queue.length) {
        const discarded = this.queue.shift();
        this.queuedFrames -= (discarded.length - this.offset) / 2;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || left;

    for (let frame = 0; frame < left.length; frame += 1) {
      if (!this.queue.length) {
        left[frame] = 0;
        right[frame] = 0;
        continue;
      }

      const current = this.queue[0];
      left[frame] = current[this.offset] || 0;
      right[frame] = current[this.offset + 1] || 0;
      this.offset += 2;
      this.queuedFrames -= 1;

      if (this.offset >= current.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('tela-pcm-player', TelaPcmPlayer);
