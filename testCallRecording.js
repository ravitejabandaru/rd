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
                window.location.origin + '/services/apexrest/CallRecording/' + this.callId,
                { headers: { "Range": "bytes=0-" } } // start from beginning
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const blob = await response.blob();

            // Create a browser-safe URL
            this.audioUrl = URL.createObjectURL(blob);
        } catch (e) {
            console.error("Error fetching recording", e);
        }
    }
}
