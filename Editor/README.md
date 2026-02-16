# AI Reply Composer

A Zendesk app that generates AI-powered replies for tickets with different tones.

## Features

- ✨ AI-powered reply generation
- 🎭 Multiple tone options (Professional, Friendly, Empathetic, Apologetic, Concise)
- 📝 Edit generated replies before sending
- 🌐 Multi-language support
- 🔄 Copy directly to Zendesk reply editor

## Installation

1. Upload this app to your Zendesk instance
2. Configure the backend URL
3. Grant necessary permissions

## Configuration

Update the `BACKEND_URL` in `assets/iframe.html` to point to your backend server.

```javascript
const BACKEND_URL = 'http://localhost:3000'; // or your production URL
```
