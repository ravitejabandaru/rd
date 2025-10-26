import { LightningElement, track } from 'lwc';

export default class AudioPlayer extends LightningElement {
    audio;
    audioUrl = 'https://example.com/call.mp3';

    @track currentTime = 0;
    @track duration = 0;
    @track isPlaying = false;

    @track hoverTimeVisible = false;
    @track hoverTime = 0;
    @track hoverStyle = '';

    renderedCallback() {
        if (!this.audio) {
            this.audio = this.template.querySelector('audio');
        }
    }

    loadMetadata = () => {
        this.duration = Math.floor(this.audio.duration);
    };

    updateTime = () => {
        this.currentTime = Math.floor(this.audio.currentTime);
    };

    seekAudio(event) {
        this.audio.currentTime = event.target.value;
        this.currentTime = event.target.value;
    }

    togglePlay = () => {
        if (this.isPlaying) {
            this.audio.pause();
        } else {
            this.audio.play();
        }
        this.isPlaying = !this.isPlaying;
    };

    // Format mm:ss
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
        return `${mins}:${secs}`;
    }

    get formattedCurrentTime() {
        return this.formatTime(this.currentTime);
    }
    get formattedDuration() {
        return this.formatTime(this.duration);
    }
    get formattedHoverTime() {
        return this.formatTime(this.hoverTime);
    }

    // Show hover preview
    showHoverTime(event) {
        const slider = this.template.querySelector('#progressBar');
        const rect = slider.getBoundingClientRect();
        const percent = (event.clientX - rect.left) / rect.width;
        const seconds = Math.floor(this.duration * percent);
        this.hoverTime = Math.min(Math.max(seconds, 0), this.duration);
        this.hoverTimeVisible = true;

        this.hoverStyle = `left:${event.clientX - rect.left}px;`;
    }

    hideHoverTime() {
        this.hoverTimeVisible = false;
    }
}
