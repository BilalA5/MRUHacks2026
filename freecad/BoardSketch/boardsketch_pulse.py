# A pulsing border round FreeCAD's 3D view while a part is being generated.
# The shader is "Pulsing Border" from the 21st.dev Shader Builder, adapted from Paper Shaders
# (https://shaders.paper.design/pulsing-border, Apache-2.0). Changes for this use:
#   - the box follows the view's size (u_box) instead of a fixed 16:9 frame,
#   - only the light travelling round the border is drawn; the unlit line is faint and the middle is
#     transparent, so the part shows through,
#   - the wave count round the border is a whole number, so the light has no seam where it wraps,
#   - u_alpha fades the whole effect in and out,
#   - it runs in desktop OpenGL (GLSL 1.20, or 3.30 core) instead of WebGL,
#   - for speed it shades only a strip round the edges (the middle would be transparent anyway) at 30 fps.
import time
from array import array

from PySide6 import QtCore, QtGui
from PySide6.QtOpenGL import QOpenGLBuffer, QOpenGLShader, QOpenGLShaderProgram, QOpenGLVertexArrayObject
from PySide6.QtOpenGLWidgets import QOpenGLWidget

# The recipe's settings (UNIFORMS in the original). Only the ones the border uses are kept;
# warp, blur, hue, vignette, drift and the cursor are all off in the recipe.
COLORS = [(0.0196, 0.0275, 0.0510), (0.0706, 0.3804, 0.6275), (0.2078, 0.7686, 0.9098), (0.9490, 0.9843, 1.0)]
SCALE, INTENSITY, PARAM_A, CONTRAST, GRAIN, SEED, TIME_SCALE = 1.26, 0.35, 0.28, 1.005, 0.042, 1.0, 0.575
FADE_IN_S, FADE_OUT_S = 0.25, 0.18   # exits are quicker than entrances
INSET = 0.06                         # where the line sits, in from the view's edge (shader units)
REACH = 0.26                         # how far in from the edge the line and its glow can show

VERT = """
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
"""

FRAG = """
uniform vec3 u_colors[4];
uniform vec2 u_resolution;
uniform float u_time;
uniform vec2 u_box;
uniform float u_alpha;

const float u_colorCount = 4.0;
const float u_scale = %(SCALE)f;
const float u_intensity = %(INTENSITY)f;
const float u_paramA = %(PARAM_A)f;
const float u_contrast = %(CONTRAST)f;
const float u_grain = %(GRAIN)f;
const float u_seed = %(SEED)f;

float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 palette(float x) {
  float n = max(u_colorCount - 1.0, 1.0);
  float f = clamp(x, 0.0, 1.0) * n;
  vec3 col = u_colors[0];
  for (int i = 0; i < 3; i++) {
    if (float(i) < n)
      col = mix(col, u_colors[i + 1], smoothstep(0.0, 1.0, clamp(f - float(i), 0.0, 1.0)));
  }
  return col;
}

// The border's colour; mask is how much of the line is here (1 on it, fading through the glow),
// light how lit it is by the travelling pulse.
vec3 shade(vec2 p, float t, out float mask, out float light) {
  vec2 d = abs(p) - u_box;
  float outside = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  float thickness = mix(0.018, 0.11, u_paramA);
  float edge = 1.0 - smoothstep(thickness * 0.35, thickness, abs(outside));
  float perimeter = atan(p.y * u_box.x, p.x * u_box.y) / 6.2831853 + 0.5;
  // The recipe's 5 + 9 * intensity radians is about 1.3 waves round the border; rounded to whole waves
  // so the light has no seam where perimeter wraps from 1 back to 0.
  float waves = max(1.0, floor((5.0 + u_intensity * 9.0) / 6.2831853 + 0.5));
  float pulse = 0.5 + 0.5 * sin(perimeter * waves * 6.2831853 - t * 1.8);
  float trail = pow(pulse, mix(7.0, 2.0, u_intensity));
  light = trail;
  float innerGlow = exp(-abs(outside) * 24.0) * 0.32;
  mask = clamp(edge + innerGlow, 0.0, 1.0);
  return mix(u_colors[0], palette(trail), mask);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
  p *= u_scale;
  float mask, light;
  vec3 col = shade(p, u_time, mask, light);
  col = (col - 0.5) * u_contrast + 0.5;
  col += (grainHash(gl_FragCoord.xy + vec2(u_seed * 17.0, u_seed * 31.0)) - 0.5) * u_grain;
  float a = mask * mix(0.12, 1.0, light) * u_alpha;   // the unlit line is a faint trace
  OUT_COLOR = vec4(clamp(col, 0.0, 1.0) * a, a);   // premultiplied, as Qt composites it
}
""" % dict(SCALE=SCALE, INTENSITY=INTENSITY, PARAM_A=PARAM_A, CONTRAST=CONTRAST, GRAIN=GRAIN, SEED=SEED)


class PulseBorder(QOpenGLWidget):
    def __init__(self, area):
        super().__init__(area)
        fmt = QtGui.QSurfaceFormat.defaultFormat()
        fmt.setAlphaBufferSize(8)
        self.setFormat(fmt)
        self.setAttribute(QtCore.Qt.WA_AlwaysStackOnTop)          # lets the 3D view show through the middle
        self.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
        self.start = time.time()
        self.alpha, self.target, self.last = 0.0, 0.0, None
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.update)
        self.prog = None
        self.strip_for = None       # the size the edge strip was built for
        area.installEventFilter(self)
        self.setGeometry(area.rect())
        self.hide()

    def play(self, on):
        """Fades the border in (on) or out."""
        self.target = 1.0 if on else 0.0
        if on:
            self.setGeometry(self.parentWidget().rect())
            self.show()
            self.raise_()
        if not self.timer.isActive():
            self.last = time.time()
            self.timer.start(33)

    def eventFilter(self, obj, event):
        if event.type() == QtCore.QEvent.Resize:
            self.setGeometry(obj.rect())
        return False

    def initializeGL(self):
        ctx = self.context()
        core = ctx.format().profile() == QtGui.QSurfaceFormat.CoreProfile
        if core:
            vert = "#version 330 core\n" + VERT.replace("attribute", "in")
            frag = "#version 330 core\nout vec4 fragColor;\n#define OUT_COLOR fragColor\n" + FRAG
        else:
            vert = "#version 120\n" + VERT
            frag = "#version 120\n#define OUT_COLOR gl_FragColor\n" + FRAG
        self.prog = QOpenGLShaderProgram(self)
        ok = self.prog.addShaderFromSourceCode(QOpenGLShader.Vertex, vert)
        ok = self.prog.addShaderFromSourceCode(QOpenGLShader.Fragment, frag) and ok
        self.prog.bindAttributeLocation("a_position", 0)
        if not (ok and self.prog.link()):
            print("[BoardSketch] pulse shader failed:", self.prog.log())
            self.prog = None
            return
        self.vao = QOpenGLVertexArrayObject(self)
        self.vao.create()
        self.vao.bind()
        self.vbo = QOpenGLBuffer(QOpenGLBuffer.VertexBuffer)
        self.vbo.create()
        self.vbo.bind()
        self.prog.bind()
        self.prog.enableAttributeArray(0)
        self.prog.setAttributeBuffer(0, 0x1406, 0, 2)            # GL_FLOAT
        for i, c in enumerate(COLORS):
            self.prog.setUniformValue(f"u_colors[{i}]", QtGui.QVector3D(*c))
        self.vao.release()

    def strip(self, w, h):
        """Four quads along the edges, as deep as the line and its glow reach; nothing else is shaded."""
        if self.strip_for == (w, h):
            return
        self.strip_for = (w, h)
        reach = REACH / SCALE * min(w, h)                 # shader units to pixels
        bx, by = min(1.0, 2 * reach / w), min(1.0, 2 * reach / h)
        quads = [(-1, 1 - by, 1, 1), (-1, -1, 1, -1 + by), (-1, -1 + by, -1 + bx, 1 - by), (1 - bx, -1 + by, 1, 1 - by)]
        pts = []
        for x0, y0, x1, y1 in quads:
            pts += [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1]
        data = array("f", pts).tobytes()
        self.vbo.bind()
        self.vbo.allocate(data, len(data))

    def paintGL(self):
        gl = self.context().functions()
        gl.glClearColor(0, 0, 0, 0)
        gl.glClear(0x4000)                                        # GL_COLOR_BUFFER_BIT
        now = time.time()
        dt = now - (self.last or now)
        self.last = now
        step = dt / (FADE_IN_S if self.target > self.alpha else FADE_OUT_S)
        self.alpha = min(self.target, self.alpha + step) if self.target > self.alpha else max(self.target, self.alpha - step)
        if self.alpha <= 0 and self.target == 0:
            self.timer.stop()
            QtCore.QTimer.singleShot(0, self.hide)
            return
        if not self.prog:
            return
        ratio = self.devicePixelRatioF()
        w, h = self.width() * ratio, self.height() * ratio
        # The border sits just inside the view's edges, in the shader's scaled, aspect-corrected space.
        box = QtGui.QVector2D(0.5 * w / min(w, h) * SCALE - INSET, 0.5 * h / min(w, h) * SCALE - INSET)
        eased = 1 - (1 - self.alpha) ** 3
        self.prog.bind()
        self.vao.bind()
        self.strip(w, h)
        self.prog.setUniformValue("u_resolution", QtGui.QVector2D(w, h))
        self.prog.setUniformValue("u_time", float((now - self.start) * TIME_SCALE))
        self.prog.setUniformValue("u_box", box)
        self.prog.setUniformValue("u_alpha", float(eased))
        gl.glDrawArrays(0x0004, 0, 24)                            # GL_TRIANGLES: 4 quads
        self.vao.release()


_pulse = None


def attach(area):
    global _pulse
    if _pulse is None:
        _pulse = PulseBorder(area)
    return _pulse
