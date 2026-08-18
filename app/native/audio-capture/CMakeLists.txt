cmake_minimum_required(VERSION 3.21)
project(AudioCapture LANGUAGES CXX)

add_executable(AudioCapture AudioCapture.cpp)
target_compile_features(AudioCapture PRIVATE cxx_std_17)
target_compile_definitions(AudioCapture PRIVATE UNICODE _UNICODE WINVER=0x0A00 _WIN32_WINNT=0x0A00)
target_link_libraries(AudioCapture PRIVATE ole32 mmdevapi mfplat)

if(MSVC)
  target_compile_options(AudioCapture PRIVATE /W4 /permissive- /EHsc)
endif()
