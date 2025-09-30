import { LightningElement, api, track } from 'lwc';

export default class CallRecordingPlayer extends LightningElement {
    @api callId;
    @track audioUrl;

    connectedCallback() {
        this.loadRecording();
    }

    async loadRecording() {
        try {
            const response = await fetch(
                `/services/apexrest/CallRecording/${this.callId}`, 
                { headers: { "Range": "bytes=0-" } }
            );
            const blob = await response.blob();
            this.audioUrl = URL.createObjectURL(blob);
        } catch (e) {
            console.error("Error fetching recording", e);
        }
    }
}
