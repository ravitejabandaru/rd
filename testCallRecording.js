import { LightningElement, wire, track } from 'lwc';
import getCallRecording from '@salesforce/apex/CallRecordingController.getCallRecording';

export default class CallRecordingPlayer extends LightningElement {
    @track audioUrl;

    connectedCallback() {
        this.loadAudio();
    }

    loadAudio() {
        getCallRecording({ callId: 'abc-123' })
            .then(base64Data => {
                // Convert Base64 to Blob
                const byteCharacters = atob(base64Data);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: 'audio/wav' });

                // Create an Object URL
                this.audioUrl = URL.createObjectURL(blob);
            })
            .catch(error => {
                console.error('Error loading audio:', error);
            });
    }
}
