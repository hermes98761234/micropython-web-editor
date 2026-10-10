export const EXAMPLES: Record<string, string> = {
  'Blink LED': `from machine import Pin
import time

led = Pin(25, Pin.OUT)  # on-board LED on the Pico; use Pin(2) on many ESP32 boards

for i in range(10):
    led.toggle()
    print("LED is", "on" if led.value() else "off")
    time.sleep(0.5)
`,
  'Hello and math': `import sys

print("Hello from MicroPython!")
print(sys.version)

def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

for i in range(10):
    print(f"fib({i}) = {fib(i)}")
`,
  'Read ADC': `from machine import ADC, Pin
import time

adc = ADC(Pin(26))
for _ in range(5):
    raw = adc.read_u16()
    print("raw", raw, "volts", round(raw / 65535 * 3.3, 3))
    time.sleep(0.2)
`,
  'Write a file': `with open("hello.txt", "w") as f:
    f.write("saved from MicroPython\\n")

import os
print(os.listdir())
`,
}
