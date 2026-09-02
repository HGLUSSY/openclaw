#ifndef OPENCLAW_WATCH_RTC_H
#define OPENCLAW_WATCH_RTC_H
#include <stddef.h>
#include <stdint.h>

typedef struct OpenClawRTC OpenClawRTC;
typedef struct {
    uint8_t address[16];
    uint16_t port;
    uint16_t family; /* 4 or 6; bytes are in network order. */
} OpenClawRTCAddress;

typedef struct {
    uint32_t kind; /* 0 timeout, 1 UDP, 2 connected, 3 Opus, 4 disconnected, 5 closed. */
    const uint8_t *bytes;
    size_t length;
    OpenClawRTCAddress source;
    OpenClawRTCAddress destination;
    uint64_t time; /* Timeout milliseconds, or Opus RTP timestamp at 48 kHz. */
} OpenClawRTCOutput;

/* One serial owner. After EVERY mutation, poll to kind=0 before mutating again.
 * Returned byte pointers expire at the next call; copy before returning to the run loop.
 * Results: 0 success, -1 failed/closed, -2 invalid input. No network I/O occurs here. */
OpenClawRTC *openclaw_rtc_create(void);
void openclaw_rtc_free(OpenClawRTC *rtc);
int32_t openclaw_rtc_add_candidate(OpenClawRTC *rtc, OpenClawRTCAddress address);
int32_t openclaw_rtc_offer(OpenClawRTC *rtc);
const uint8_t *openclaw_rtc_description(const OpenClawRTC *rtc, size_t *length);
int32_t openclaw_rtc_answer(OpenClawRTC *rtc, const uint8_t *bytes, size_t length);
int32_t openclaw_rtc_receive(OpenClawRTC *rtc, OpenClawRTCAddress source,
                           OpenClawRTCAddress destination, const uint8_t *bytes, size_t length);
int32_t openclaw_rtc_send_opus(OpenClawRTC *rtc, const uint8_t *bytes, size_t length,
                             uint64_t timestamp);
int32_t openclaw_rtc_timeout(OpenClawRTC *rtc);
int32_t openclaw_rtc_poll(OpenClawRTC *rtc, OpenClawRTCOutput *output);
#endif
