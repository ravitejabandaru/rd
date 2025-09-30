import { LightningElement, api, track } from 'lwc';

export default class CallRecording extends LightningElement {
    @api callId;
    @track audioUrl;

    connectedCallback() {
        this.audioUrl = `/services/apexrest/CallRecording/${this.callId}`;
    }
}
