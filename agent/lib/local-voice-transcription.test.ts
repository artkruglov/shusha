import { describe, expect, it, vi } from 'vitest';
import { transcribeLocalVoice } from './local-voice-transcription.js';

describe('local voice transcription', () => {
  it('sends validated audio only to the fixed internal service', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({text:'Купить молоко'}));
    await expect(transcribeLocalVoice(new Uint8Array([1,2]), 'test-key', request)).resolves.toBe('Купить молоко');
    expect(request.mock.calls[0][0]).toBe('http://gigaam:8000/transcribe');
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(request.mock.calls[0][1].redirect).toBe('error');
  });
  it.each([503,413,422])('does not retry a failed transcription (%s)', async status => {
    const request=vi.fn().mockResolvedValue(new Response('',{status}));
    await expect(transcribeLocalVoice(new Uint8Array([1]),'test',request)).rejects.toThrow(/AGENT_VOICE_/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('waits out a busy service, which had not read the audio, and says so when it stays busy', async () => {
    const busy = () => Response.json({error:'busy'},{status:503});
    const request=vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(Response.json({text:'Купить хлеб'}));
    await expect(transcribeLocalVoice(new Uint8Array([1]),'test',request,'audio/webm',0)).resolves.toBe('Купить хлеб');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1].headers['Content-Type']).toBe('audio/webm');
    const always=vi.fn().mockImplementation(async()=>busy());
    await expect(transcribeLocalVoice(new Uint8Array([1]),'test',always,'audio/ogg',0)).rejects.toThrow(/AGENT_VOICE_BUSY/);
    expect(always).toHaveBeenCalledTimes(7);
  });
  it('rejects an empty transcript', async () => {
    await expect(transcribeLocalVoice(new Uint8Array([1]),'test',async()=>Response.json({text:' '}))).rejects.toThrow(/AGENT_VOICE_TRANSCRIPT_EMPTY/);
  });
});
