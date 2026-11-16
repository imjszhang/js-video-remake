// Encode an AudioBuffer as a 16-bit PCM WAV and return it base64-encoded, which is what
// the renderer reads back from window.__film.exportWav().
export function audioBufferToWav(rendered) {
    const channels = [];
    for (let channel = 0; channel < rendered.numberOfChannels; channel++) channels.push(rendered.getChannelData(channel));
    const bytesPerSample = 2;
    const header = 44;
    const dataBytes = channels[0].length * channels.length * bytesPerSample;
    const buffer = new ArrayBuffer(header + dataBytes);
    const view = new DataView(buffer);
    const write = (offset, value) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
    write(0, 'RIFF');
    view.setUint32(4, buffer.byteLength - 8, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels.length, true);
    view.setUint32(24, rendered.sampleRate, true);
    view.setUint32(28, rendered.sampleRate * channels.length * bytesPerSample, true);
    view.setUint16(32, channels.length * bytesPerSample, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, dataBytes, true);
    for (let sample = 0; sample < channels[0].length; sample++) {
        for (let channel = 0; channel < channels.length; channel++) {
            const clamped = Math.max(-1, Math.min(1, channels[channel][sample]));
            view.setInt16(header + (sample * channels.length + channel) * bytesPerSample, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        }
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
}
