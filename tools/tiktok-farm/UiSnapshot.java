import java.lang.reflect.Method;

/** Read the current Android accessibility tree without waiting for an idle video feed. */
public final class UiSnapshot {
    private static final StringBuilder xml = new StringBuilder(32768);
    private static int count;

    private static Object call(Object object, String method) throws Exception {
        return object.getClass().getMethod(method).invoke(object);
    }

    private static String escape(Object value) {
        if (value == null) return "";
        return value.toString().replace("&", "&amp;").replace("\"", "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;")
            .replaceAll("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]", "");
    }

    private static void attribute(String name, Object value) {
        xml.append(' ').append(name).append("=\"").append(escape(value)).append('"');
    }

    private static void node(Object value, int depth) throws Exception {
        if (value == null || depth > 80 || ++count > 2500) return;
        try {
            boolean password = Boolean.TRUE.equals(call(value, "isPassword"));
            Object bounds = Class.forName("android.graphics.Rect").getConstructor().newInstance();
            value.getClass().getMethod("getBoundsInScreen", bounds.getClass()).invoke(value, bounds);
            xml.append("<node");
            attribute("text", password ? "" : call(value, "getText"));
            attribute("content-desc", password ? "" : call(value, "getContentDescription"));
            attribute("class", call(value, "getClassName"));
            attribute("package", call(value, "getPackageName"));
            attribute("enabled", call(value, "isEnabled"));
            attribute("clickable", call(value, "isClickable"));
            attribute("password", password);
            attribute("bounds", call(bounds, "toShortString"));
            xml.append('>');
            int children = (Integer) call(value, "getChildCount");
            Method child = value.getClass().getMethod("getChild", int.class);
            for (int i = 0; i < children && count < 2500; i++) node(child.invoke(value, i), depth + 1);
            xml.append("</node>");
        } finally {
            call(value, "recycle");
        }
    }

    public static void main(String[] args) {
        Object bridge = null;
        int result = 1;
        try {
            bridge = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper")
                .getConstructor().newInstance();
            call(bridge, "connect");
            Object automation = call(bridge, "getUiAutomation");
            Object root = null;
            for (int i = 0; i < 20 && root == null; i++) {
                root = call(automation, "getRootInActiveWindow");
                if (root == null) Thread.sleep(100);
            }
            if (root == null) throw new IllegalStateException();
            xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy>");
            node(root, 0);
            xml.append("</hierarchy>");
            System.out.print(xml);
            result = 0;
        } catch (Exception error) {
            // Never include UI contents, credentials or exception messages in diagnostics.
            System.err.println("UI snapshot unavailable");
        } finally {
            if (bridge != null) try { call(bridge, "disconnect"); } catch (Exception ignored) { }
        }
        System.exit(result);
    }
}
