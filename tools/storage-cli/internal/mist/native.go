//go:build mistlib_native

package mist

/*
#cgo linux LDFLAGS: -L${SRCDIR}/lib -Wl,-Bstatic -lmistlib -Wl,-Bdynamic -ldl -lm -lpthread -lstdc++ -lssl -lcrypto -lz -lrt -lutil
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

typedef void (*log_callback_t)(uint32_t, uint8_t*, size_t);
typedef void (*event_callback_t)(uint32_t, uint8_t*, size_t, uint8_t*, size_t);
extern void goMistLog(uint32_t level, uint8_t* data, size_t length);
extern void goMistEvent(uint32_t eventType, uint8_t* fromPtr, size_t fromLen, uint8_t* dataPtr, size_t dataLen);
void register_log_callback(log_callback_t cb);
void register_event_callback(event_callback_t cb);

static inline void register_go_mist_log() {
	register_log_callback((log_callback_t)goMistLog);
}
static inline void register_go_mist_event() {
	register_event_callback((event_callback_t)goMistEvent);
}

void init(const uint8_t* id_ptr, size_t id_len, const uint8_t* url_ptr, size_t url_len);
bool init_with_config(const uint8_t* id_ptr, size_t id_len, const uint8_t* config_ptr, size_t config_len);
void join_room(const uint8_t* room_ptr, size_t room_len);
void leave_room(void);
void update_position(float x, float y, float z);
uint32_t get_stats(uint8_t* buffer, size_t buffer_len);
void send_message(const uint8_t* target_ptr, size_t target_len, const uint8_t* data_ptr, size_t data_len, uint32_t method);
uint32_t storage_add(const uint8_t* name_ptr, size_t name_len, const uint8_t* data_ptr, size_t data_len, uint8_t* cid_buffer, size_t cid_buffer_len);
uint32_t storage_get(const uint8_t* cid_ptr, size_t cid_len, uint8_t* buffer, size_t buffer_len);
*/
import "C"

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"unsafe"
)

// mistlib log/event callbacks are process-global, so the handlers live at
// package scope guarded by a mutex. cgo invokes the exported funcs below from
// mistlib's runtime threads.
var (
	cbMu         sync.RWMutex
	logHandler   LogFunc
	eventHandler EventFunc
)

//export goMistLog
func goMistLog(level C.uint32_t, data *C.uint8_t, length C.size_t) {
	cbMu.RLock()
	fn := logHandler
	cbMu.RUnlock()
	if fn == nil {
		return
	}
	msg := C.GoStringN((*C.char)(unsafe.Pointer(data)), C.int(length))
	fn(uint32(level), strings.TrimSpace(msg))
}

//export goMistEvent
func goMistEvent(eventType C.uint32_t, fromPtr *C.uint8_t, fromLen C.size_t, dataPtr *C.uint8_t, dataLen C.size_t) {
	cbMu.RLock()
	fn := eventHandler
	cbMu.RUnlock()
	if fn == nil {
		return
	}
	from := C.GoStringN((*C.char)(unsafe.Pointer(fromPtr)), C.int(fromLen))
	payload := C.GoBytes(unsafe.Pointer(dataPtr), C.int(dataLen))
	fn(uint32(eventType), from, payload)
}

// NativeClient binds the mistlib-native C FFI (mistlib-dev, enhance/peer-connection).
// The native library is a process-wide singleton, so a single client value drives
// the one underlying mist node.
type NativeClient struct{}

func NewNativeClient() *NativeClient { return &NativeClient{} }

func (c *NativeClient) Init(_ context.Context, nodeID string, config string) error {
	id := C.CBytes([]byte(nodeID))
	cfg := C.CBytes([]byte(config))
	defer C.free(id)
	defer C.free(cfg)
	ok := C.init_with_config(
		(*C.uint8_t)(id), C.size_t(len(nodeID)),
		(*C.uint8_t)(cfg), C.size_t(len(config)),
	)
	if !bool(ok) {
		return fmt.Errorf("mist: init_with_config failed for node %q", nodeID)
	}
	return nil
}

func (c *NativeClient) JoinRoom(_ context.Context, roomID string) error {
	room := C.CBytes([]byte(roomID))
	defer C.free(room)
	C.join_room((*C.uint8_t)(room), C.size_t(len(roomID)))
	return nil
}

func (c *NativeClient) Networked() bool { return true }

func (c *NativeClient) SetLogCallback(fn LogFunc) {
	cbMu.Lock()
	logHandler = fn
	cbMu.Unlock()
	C.register_go_mist_log()
}

func (c *NativeClient) SetEventCallback(fn EventFunc) {
	cbMu.Lock()
	eventHandler = fn
	cbMu.Unlock()
	C.register_go_mist_event()
}

func (c *NativeClient) UpdatePosition(_ context.Context, x, y, z float32) error {
	C.update_position(C.float(x), C.float(y), C.float(z))
	return nil
}

func (c *NativeClient) Stats(_ context.Context) ([]byte, error) {
	buf := make([]byte, 1<<16)
	n := int(C.get_stats((*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf))))
	if n == 0 {
		return nil, fmt.Errorf("mist: get_stats failed")
	}
	return buf[:n], nil
}

func (c *NativeClient) SendMessage(_ context.Context, targetID string, data []byte, method int) error {
	target := C.CBytes([]byte(targetID))
	payload := C.CBytes(data)
	defer C.free(target)
	defer C.free(payload)
	C.send_message(
		(*C.uint8_t)(target), C.size_t(len(targetID)),
		(*C.uint8_t)(payload), C.size_t(len(data)),
		C.uint32_t(method),
	)
	return nil
}

func (c *NativeClient) StorageAdd(_ context.Context, name string, data []byte) (string, error) {
	cname := C.CBytes([]byte(name))
	cdata := C.CBytes(data)
	defer C.free(cname)
	defer C.free(cdata)

	cidBuf := make([]byte, 256)
	n := C.storage_add(
		(*C.uint8_t)(cname), C.size_t(len(name)),
		(*C.uint8_t)(cdata), C.size_t(len(data)),
		(*C.uint8_t)(unsafe.Pointer(&cidBuf[0])), C.size_t(len(cidBuf)),
	)
	if n == 0 {
		return "", fmt.Errorf("mist: storage_add failed for %q", name)
	}
	return string(cidBuf[:int(n)]), nil
}

func (c *NativeClient) StorageGet(_ context.Context, cid string) ([]byte, error) {
	ccid := C.CBytes([]byte(cid))
	defer C.free(ccid)

	// storage_get returns the required length when the buffer is too small, so
	// grow and retry. Start with a generous buffer to avoid a second call for
	// typical payloads.
	bufLen := 1 << 16
	for {
		buf := make([]byte, bufLen)
		n := int(C.storage_get(
			(*C.uint8_t)(ccid), C.size_t(len(cid)),
			(*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(bufLen),
		))
		if n == 0 {
			return nil, fmt.Errorf("mist: storage_get failed or empty for %q", cid)
		}
		if n <= bufLen {
			return buf[:n], nil
		}
		bufLen = n // buffer was too small; retry with the reported size
	}
}
