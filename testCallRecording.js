import { LightningElement, api, track } from 'lwc';
import getCallRecordingChunk from '@salesforce/apex/CallRecordingController.getCallRecordingChunk';

const CHUNK_SIZE = 1024 * 512; // 512 KB per chunk

export default class CallRecordingChunkPlayer extends LightningElement {
    @api callId;
    @track audioUrl;

    async connectedCallback() {
        await this.loadChunks();
    }

    async loadChunks() {
        try {
            let start = 0;
            let chunks = [];
            const totalSize = 5 * 1024 * 1024; // TODO: replace with actual file size if known

            while (start < totalSize) {
                const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);

                const base64Chunk = await getCallRecordingChunk({
                    callId: this.callId,
                    start: start,
                    end: end
                });

                // Convert base64 → bytes
                const byteChars = atob(base64Chunk);
                const byteNumbers = new Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) {
                    byteNumbers[i] = byteChars.charCodeAt(i);
                }
                chunks.push(new Uint8Array(byteNumbers));

                start += CHUNK_SIZE;
            }

            // Combine all chunks into one Blob
            const blob = new Blob(chunks, { type: 'audio/wav' });
            this.audioUrl = URL.createObjectURL(blob);

        } catch (e) {
            console.error('Error loading audio chunks:', e);
        }
    }
}
