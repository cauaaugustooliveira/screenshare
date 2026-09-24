# ScreenShare

A desktop application for real-time screen sharing between multiple participants in private rooms.

ScreenShare was built as a lightweight alternative for groups that want to share multiple screens simultaneously while using another platform for voice communication.

The application runs on Windows and uses **Electron** for the desktop client and **LiveKit** for real-time media transmission.

## Features

* Join private rooms using a room code
* Multiple participants in the same room
* Multiple simultaneous screen shares
* Screen and application window selection
* System audio capture
* Microphone support
* Individual participant audio controls
* Real-time media transmission
* Portable Windows executable
* Windows installer generation

## Tech Stack

* **JavaScript**
* **Node.js**
* **Electron**
* **LiveKit**
* **WebRTC**
* **CMake**
* Native Windows audio capture
* **Electron Builder**

## How It Works

ScreenShare uses LiveKit as the real-time communication layer.

Each participant joins a room using a shared room code. Once connected, users can publish their screen, system audio, and microphone while receiving streams from other participants.

The desktop application is responsible for:

1. Managing the Electron window and desktop capture permissions
2. Connecting users to LiveKit rooms
3. Publishing and receiving media tracks
4. Handling screen and window selection
5. Managing local and remote audio
6. Communicating with the native Windows audio capture helper

## Project Structure

```text
screenshare/
│
├── app/
│   ├── assets/
│   ├── native/
│   │   └── audio-capture/
│   ├── renderer/
│   ├── main.js
│   ├── preload.js
│   ├── package.json
│   └── credentials.json.example
│
├── README.md
├── LICENSE
└── .gitignore
```

## Requirements

To run the project locally, you will need:

* Windows 10 or Windows 11
* Node.js
* npm
* A LiveKit project

To compile the native audio helper:

* Visual Studio Build Tools 2022
* Desktop Development with C++
* Windows SDK
* CMake

## Installation

Clone the repository:

```bash
git clone https://github.com/cauaaugustooliveira/screenshare.git
```

Enter the application directory:

```bash
cd screenshare/app
```

Install the dependencies:

```bash
npm install
```

## LiveKit Configuration

Create a LiveKit project and obtain the required credentials.

Copy:

```text
credentials.json.example
```

to:

```text
credentials.json
```

Then configure your LiveKit credentials:

```json
{
  "LIVEKIT_URL": "wss://your-project.livekit.cloud",
  "LIVEKIT_API_KEY": "YOUR_API_KEY",
  "LIVEKIT_API_SECRET": "YOUR_API_SECRET"
}
```

Do not commit `credentials.json` to the repository.

> **Security note:** API secrets should not be distributed inside public desktop applications in a production environment. A production version should generate LiveKit access tokens through a trusted backend service instead.

## Native Audio Capture

ScreenShare includes a native helper responsible for system audio capture on Windows.

From the `app` directory, open the **x64 Native Tools Command Prompt for Visual Studio 2022** and run:

```bash
cmake -S native/audio-capture \
      -B native/audio-capture/build \
      -G "NMake Makefiles" \
      -DCMAKE_BUILD_TYPE=Release
```

Then compile it:

```bash
cmake --build native/audio-capture/build
```

The executable will be generated at:

```text
native/audio-capture/build/AudioCapture.exe
```

## Running the Application

For development:

```bash
npm start
```

## Building for Windows

After compiling the native audio helper, generate the Windows builds with:

```bash
npm run dist
```

Electron Builder generates both an installer and a portable executable.

Example outputs:

```text
ScreenShare.exe
ScreenShare-Portable-1.0.0.exe
```

## Usage

1. Open ScreenShare
2. Enter your display name
3. Enter a room code
4. Join the room
5. Share your screen or application window
6. Other participants using the same room code will receive the stream

Multiple participants can share their screens simultaneously.

## What I Learned

This project was created to explore concepts beyond traditional web development, including:

* Real-time communication
* WebRTC-based media streaming
* Desktop application development
* Electron process architecture
* IPC communication
* Native Windows integration
* Audio capture
* Application packaging and distribution
* Managing multiple simultaneous media streams

## Future Improvements

* Backend service for secure LiveKit token generation
* Authentication system
* Room ownership and permissions
* Improved connection recovery
* Better device selection
* Automatic updates
* Screen-sharing quality controls
* Cross-platform support
* Signed Windows builds

## License

This project is licensed under the MIT License.

## Author

**Cauã Augusto de Oliveira**

* GitHub: [cauaaugustooliveira](https://github.com/cauaaugustooliveira)
* Portfolio: [orezindev.vercel.app](https://orezindev.vercel.app)
* LinkedIn: [Cauã Augusto de Oliveira](https://www.linkedin.com/in/cau%C3%A3-augusto-oliveira-2487362ba/)
