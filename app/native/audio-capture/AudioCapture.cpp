// Captura de loopback por processo (WASAPI) para uso pelo app Tela.
// stdout é um protocolo binário: cabeçalho TLAU de 16 bytes seguido de
// float32 little-endian, estéreo, 48 kHz. stderr contém somente diagnósticos.

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <mfapi.h>
#include <ks.h>
#include <ksmedia.h>
#include <tlhelp32.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <cwctype>
#include <iostream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr uint32_t kOutputSampleRate = 48000;
constexpr uint16_t kOutputChannels = 2;

#pragma pack(push, 1)
struct StreamHeader {
  char magic[4];       // "TLAU"
  uint16_t version;    // 1
  uint16_t channels;   // 2
  uint32_t sampleRate; // 48000
  uint16_t bits;       // 32 (float)
  uint16_t reserved;
};
#pragma pack(pop)
static_assert(sizeof(StreamHeader) == 16, "The Electron parser expects 16 bytes");

struct ProcessInfo {
  DWORD pid;
  DWORD parentPid;
  std::wstring executable;
};

struct InputFormat {
  uint32_t sampleRate;
  uint16_t channels;
  uint16_t bytesPerSample;
  bool isFloat;
};

std::wstring ToLower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), ::towlower);
  return value;
}

bool IsDiscordExecutable(const std::wstring& executable) {
  const auto name = ToLower(executable);
  return name == L"discord.exe" || name == L"discordcanary.exe" || name == L"discordptb.exe";
}

std::vector<DWORD> FindDiscordRoots() {
  std::unordered_map<DWORD, ProcessInfo> processes;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {
    throw std::runtime_error("CreateToolhelp32Snapshot falhou");
  }

  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      processes.emplace(entry.th32ProcessID, ProcessInfo{
        entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile,
      });
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);

  std::vector<DWORD> roots;
  for (const auto& [pid, info] : processes) {
    if (!IsDiscordExecutable(info.executable)) continue;

    const auto parent = processes.find(info.parentPid);
    if (parent == processes.end() || !IsDiscordExecutable(parent->second.executable)) {
      roots.push_back(pid);
    }
  }
  std::sort(roots.begin(), roots.end());
  return roots;
}

void WriteStderr(const std::string& text) {
  std::cerr << text << std::endl;
}

void ThrowIfFailed(HRESULT hr, const char* action) {
  if (FAILED(hr)) {
    char message[160]{};
    std::snprintf(message, sizeof(message), "%s (HRESULT 0x%08lX)", action,
      static_cast<unsigned long>(hr));
    throw std::runtime_error(message);
  }
}

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler {
 public:
  ActivationHandler() : event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~ActivationHandler() {
    if (event_) CloseHandle(event_);
  }

  HANDLE event() const { return event_; }
  HRESULT result() const { return result_; }
  ComPtr<IUnknown> activatedInterface() const { return activatedInterface_; }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activationResult = E_FAIL;
    IUnknown* activated = nullptr;
    const HRESULT getResult = operation->GetActivateResult(&activationResult, &activated);
    result_ = FAILED(getResult) ? getResult : activationResult;
    if (activated) activatedInterface_.Attach(activated);
    SetEvent(event_);
    return S_OK;
  }

  STDMETHODIMP QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
        iid == __uuidof(IAgileObject)) {
      *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&references_); }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG references = InterlockedDecrement(&references_);
    if (!references) delete this;
    return references;
  }

 private:
  LONG references_ = 1;
  HANDLE event_ = nullptr;
  HRESULT result_ = E_FAIL;
  ComPtr<IUnknown> activatedInterface_;
};

InputFormat ReadInputFormat(const WAVEFORMATEX* format) {
  if (!format || format->nSamplesPerSec == 0 || format->nChannels == 0) {
    throw std::runtime_error("Formato de mixagem WASAPI inválido");
  }

  WORD tag = format->wFormatTag;
  GUID subtype{};
  if (tag == WAVE_FORMAT_EXTENSIBLE) {
    if (format->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
      throw std::runtime_error("WAVE_FORMAT_EXTENSIBLE inválido");
    }
    subtype = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format)->SubFormat;
    if (subtype == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) tag = WAVE_FORMAT_IEEE_FLOAT;
    if (subtype == KSDATAFORMAT_SUBTYPE_PCM) tag = WAVE_FORMAT_PCM;
  }

  InputFormat result{
    format->nSamplesPerSec,
    format->nChannels,
    static_cast<uint16_t>(format->wBitsPerSample / 8),
    tag == WAVE_FORMAT_IEEE_FLOAT,
  };

  if ((tag != WAVE_FORMAT_PCM && tag != WAVE_FORMAT_IEEE_FLOAT) ||
      result.bytesPerSample == 0 || result.bytesPerSample > 4 ||
      (result.isFloat && result.bytesPerSample != 4)) {
    throw std::runtime_error("Formato de áudio do Windows não suportado");
  }
  return result;
}

float ReadSample(const BYTE* data, const InputFormat& format) {
  if (format.isFloat) {
    float value;
    std::memcpy(&value, data, sizeof(value));
    return std::clamp(value, -1.0f, 1.0f);
  }

  switch (format.bytesPerSample) {
    case 2: {
      int16_t value;
      std::memcpy(&value, data, sizeof(value));
      return static_cast<float>(value) / 32768.0f;
    }
    case 3: {
      int32_t value = static_cast<int32_t>(data[0]) |
        (static_cast<int32_t>(data[1]) << 8) |
        (static_cast<int32_t>(data[2]) << 16);
      if (value & 0x00800000) value |= 0xFF000000;
      return static_cast<float>(value) / 8388608.0f;
    }
    case 4: {
      int32_t value;
      std::memcpy(&value, data, sizeof(value));
      return static_cast<float>(value) / 2147483648.0f;
    }
    default:
      throw std::runtime_error("Profundidade PCM não suportada");
  }
}

void WriteAll(const void* bytes, size_t length) {
  const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
  const auto* current = static_cast<const BYTE*>(bytes);
  while (length) {
    const DWORD requested = static_cast<DWORD>(std::min<size_t>(length, 64 * 1024));
    DWORD written = 0;
    if (!WriteFile(output, current, requested, &written, nullptr) || written == 0) {
      throw std::runtime_error("Não foi possível escrever PCM no stdout");
    }
    current += written;
    length -= written;
  }
}

class StereoResampler {
 public:
  explicit StereoResampler(const InputFormat& input)
      : input_(input), step_(static_cast<double>(input.sampleRate) / kOutputSampleRate) {}

  void Append(const BYTE* data, UINT32 frames, bool silent) {
    const size_t inputFrameBytes = input_.bytesPerSample * input_.channels;
    samples_.reserve(samples_.size() + static_cast<size_t>(frames) * 2);
    for (UINT32 frame = 0; frame < frames; ++frame) {
      float left = 0.0f;
      float right = 0.0f;
      if (!silent) {
        const BYTE* source = data + static_cast<size_t>(frame) * inputFrameBytes;
        left = ReadSample(source, input_);
        right = input_.channels == 1
          ? left
          : ReadSample(source + input_.bytesPerSample, input_);
      }
      samples_.push_back(left);
      samples_.push_back(right);
    }
    EmitAvailable();
  }

 private:
  void EmitAvailable() {
    std::vector<float> output;
    const size_t inputFrames = samples_.size() / 2;
    while (position_ + 1.0 < static_cast<double>(inputFrames)) {
      const size_t before = static_cast<size_t>(position_);
      const double fraction = position_ - before;
      for (size_t channel = 0; channel < 2; ++channel) {
        const float a = samples_[before * 2 + channel];
        const float b = samples_[(before + 1) * 2 + channel];
        output.push_back(a + static_cast<float>((b - a) * fraction));
      }
      position_ += step_;
    }

    const size_t consumed = static_cast<size_t>(position_);
    if (consumed) {
      samples_.erase(samples_.begin(), samples_.begin() + consumed * 2);
      position_ -= consumed;
    }
    if (!output.empty()) WriteAll(output.data(), output.size() * sizeof(float));
  }

  InputFormat input_;
  double step_;
  double position_ = 0.0;
  std::vector<float> samples_;
};

ComPtr<IAudioClient> ActivateProcessLoopback(DWORD targetProcessId) {
  AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
  parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  parameters.ProcessLoopbackParams.TargetProcessId = targetProcessId;
  parameters.ProcessLoopbackParams.ProcessLoopbackMode =
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activation{};
  activation.vt = VT_BLOB;
  activation.blob.cbSize = sizeof(parameters);
  activation.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);

  auto* rawHandler = new ActivationHandler();
  ComPtr<IActivateAudioInterfaceCompletionHandler> handler;
  handler.Attach(rawHandler);
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  ThrowIfFailed(ActivateAudioInterfaceAsync(
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    __uuidof(IAudioClient),
    &activation,
    handler.Get(),
    &operation), "ActivateAudioInterfaceAsync");

  if (WaitForSingleObject(rawHandler->event(), 10'000) != WAIT_OBJECT_0) {
    throw std::runtime_error("Timeout ativando o loopback de processo");
  }
  ThrowIfFailed(rawHandler->result(), "Ativação WASAPI");

  ComPtr<IAudioClient> client;
  ThrowIfFailed(rawHandler->activatedInterface().As(&client), "QueryInterface IAudioClient");
  return client;
}

void Capture(DWORD targetProcessId, const std::vector<DWORD>& expectedDiscordRoots,
             HANDLE parentProcess) {
  ComPtr<IAudioClient> audioClient = ActivateProcessLoopback(targetProcessId);

  // Não use GetMixFormat aqui: ele retorna E_NOTIMPL em algumas versões que
  // suportam Process Loopback. Pedimos explicitamente o formato do protocolo
  // e deixamos o WASAPI converter/resamplear, como o sample oficial faz.
  WAVEFORMATEX captureFormat{};
  captureFormat.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  captureFormat.nChannels = kOutputChannels;
  captureFormat.nSamplesPerSec = kOutputSampleRate;
  captureFormat.wBitsPerSample = 32;
  captureFormat.nBlockAlign = captureFormat.nChannels * captureFormat.wBitsPerSample / 8;
  captureFormat.nAvgBytesPerSec = captureFormat.nSamplesPerSec * captureFormat.nBlockAlign;

  HANDLE dataReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!dataReady) {
    throw std::runtime_error("CreateEvent falhou");
  }

  const HRESULT initialize = audioClient->Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    0, 0, &captureFormat, nullptr);
  ThrowIfFailed(initialize, "IAudioClient::Initialize");
  ThrowIfFailed(audioClient->SetEventHandle(dataReady), "IAudioClient::SetEventHandle");

  ComPtr<IAudioCaptureClient> captureClient;
  ThrowIfFailed(audioClient->GetService(__uuidof(IAudioCaptureClient),
    reinterpret_cast<void**>(captureClient.GetAddressOf())), "IAudioClient::GetService");

  // Confirma o formato antes de qualquer byte PCM.
  const StreamHeader header{{'T', 'L', 'A', 'U'}, 1, kOutputChannels,
    kOutputSampleRate, 32, 0};
  WriteAll(&header, sizeof(header));

  ThrowIfFailed(audioClient->Start(), "IAudioClient::Start");
  const auto stopClient = [&]() { audioClient->Stop(); CloseHandle(dataReady); };

  ULONGLONG lastTopologyCheck = GetTickCount64();
  try {
    for (;;) {
      HANDLE waitHandles[2] = {dataReady, parentProcess};
      const DWORD handleCount = parentProcess ? 2 : 1;
      const DWORD wait = WaitForMultipleObjects(handleCount, waitHandles, FALSE, 250);
      if (parentProcess && wait == WAIT_OBJECT_0 + 1) {
        // Mesmo se o Electron for finalizado à força, o helper não sobrevive.
        stopClient();
        return;
      }
      if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) {
        throw std::runtime_error("Falha aguardando dados de áudio");
      }

      // O WASAPI aceita um alvo fixo. Se a topologia do Discord mudar, encerrar
      // é a opção conservadora: evita continuar capturando uma nova árvore não filtrada.
      if (GetTickCount64() - lastTopologyCheck >= 500) {
        const auto currentRoots = FindDiscordRoots();
        if (currentRoots != expectedDiscordRoots) {
          throw std::runtime_error("A topologia do Discord mudou; reinicie o compartilhamento de áudio");
        }
        lastTopologyCheck = GetTickCount64();
      }

      UINT32 packetFrames = 0;
      ThrowIfFailed(captureClient->GetNextPacketSize(&packetFrames),
        "IAudioCaptureClient::GetNextPacketSize");
      while (packetFrames) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        ThrowIfFailed(captureClient->GetBuffer(&data, &frames, &flags, nullptr, nullptr),
          "IAudioCaptureClient::GetBuffer");
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          std::vector<float> silence(static_cast<size_t>(frames) * kOutputChannels, 0.0f);
          WriteAll(silence.data(), silence.size() * sizeof(float));
        } else {
          WriteAll(data, static_cast<size_t>(frames) * captureFormat.nBlockAlign);
        }
        ThrowIfFailed(captureClient->ReleaseBuffer(frames), "IAudioCaptureClient::ReleaseBuffer");
        ThrowIfFailed(captureClient->GetNextPacketSize(&packetFrames),
          "IAudioCaptureClient::GetNextPacketSize");
      }
    }
  } catch (...) {
    stopClient();
    throw;
  }
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  HRESULT coInitialize = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(coInitialize) && coInitialize != RPC_E_CHANGED_MODE) {
    WriteStderr("ERROR CoInitializeEx falhou");
    return 1;
  }

  const HRESULT mediaFoundation = MFStartup(MF_VERSION, MFSTARTUP_LITE);
  if (FAILED(mediaFoundation)) {
    WriteStderr("ERROR MFStartup falhou");
    if (SUCCEEDED(coInitialize)) CoUninitialize();
    return 1;
  }

  try {
    DWORD parentPid = 0;
    constexpr wchar_t kParentPrefix[] = L"--parent-pid=";
    for (int index = 1; index < argc; ++index) {
      const std::wstring argument(argv[index]);
      if (argument.rfind(kParentPrefix, 0) == 0) {
        parentPid = static_cast<DWORD>(std::wcstoul(
          argument.c_str() + (sizeof(kParentPrefix) / sizeof(kParentPrefix[0])) - 1,
          nullptr, 10));
      }
    }
    HANDLE parentProcess = parentPid
      ? OpenProcess(SYNCHRONIZE, FALSE, parentPid)
      : nullptr;
    if (parentPid && !parentProcess) {
      throw std::runtime_error("Não foi possível monitorar o processo Electron pai");
    }

    const std::vector<DWORD> discordRoots = FindDiscordRoots();
    if (discordRoots.size() > 1) {
      // A API oficial só recebe um PID/alvo. Não misturamos capturas parciais,
      // pois isso permitiria que a outra árvore do Discord entrasse no resultado.
      throw std::runtime_error("Há mais de uma árvore independente do Discord; áudio não iniciado por segurança");
    }

    const DWORD target = discordRoots.empty() ? GetCurrentProcessId() : discordRoots.front();
    if (discordRoots.empty()) {
      WriteStderr("STATUS Discord não encontrado; capturando todo o áudio atual do sistema");
    } else {
      WriteStderr("STATUS Excluindo árvore do Discord PID " + std::to_string(target));
    }
    Capture(target, discordRoots, parentProcess);
    if (parentProcess) CloseHandle(parentProcess);
  } catch (const std::exception& error) {
    WriteStderr(std::string("ERROR ") + error.what());
    MFShutdown();
    if (SUCCEEDED(coInitialize)) CoUninitialize();
    return 1;
  }

  MFShutdown();
  if (SUCCEEDED(coInitialize)) CoUninitialize();
  return 0;
}
