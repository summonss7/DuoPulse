# DuoPulse — локальный ASR-движок мобильной ветки (карточка duopulse-168,
# паритет 5/8 аудита duopulse-156). Решение: externalNativeBuild/CMake в app-
# модуле (НЕ prefab .so): whisper.cpp той же ревизии, что у десктопного спайка
# (e2e/asr/prepare.mjs — пин полного SHA ниже), собирается NDK-клангом под
# оба ABI приложения; один источник ревизии для десктопа/мобайла и никаких
# бинарников в git. Первая сборка клонирует whisper.cpp (FetchContent кэш —
# в build-каталоге gradle), повторные — мгновенны.
#
# Выход: libwhisperjni.so = whisper + ggml + JNI-шим whisper_jni.cpp
# (Java_dev_duopulse_mobile_MobileAsrHelper_*). GGML_OPENMP=OFF — та же
# причина, что у статической MinGW-сборки десктопа: без лишних рантаймов.
# Примеры/сервер/тесты whisper выключены; общая либа не нужна (шим — единственный
# потребитель).

cmake_minimum_required(VERSION 3.22)
project(duopulse_asr LANGUAGES C CXX)

include(FetchContent)

set(FETCHCONTENT_QUIET OFF)
FetchContent_Declare(
  whispercpp
  GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp.git
  # пин спайка duopulse-060 / десктопного e2e/asr: полный SHA (мелкий fetch
  # произвольного SHA GitHub не отдаёт)
  GIT_TAG 284029c07012d2000941a08d38a31ffb71f4734e
)

set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS     OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_COMMON    OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP             OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE             OFF CACHE BOOL "" FORCE) # без -march=native: ABI-портабельность
set(BUILD_SHARED_LIBS       OFF CACHE BOOL "" FORCE) # whisper статикой внутрь шима

FetchContent_MakeAvailable(whispercpp)

add_library(whisperjni SHARED whisper_jni.cpp)
target_compile_options(whisperjni PRIVATE -O3 -fvisibility=hidden)
target_link_libraries(whisperjni PRIVATE whisper log)
