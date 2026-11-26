import groovy.grape.Grape;
import groovy.lang.Binding;
import groovy.lang.GroovyShell;
import groovy.lang.GroovySystem;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import org.codehaus.groovy.control.MultipleCompilationErrorsException;
import org.codehaus.groovy.control.messages.SyntaxErrorMessage;

/** Executes explicitly requested Groovy snippets inside a separately owned JVM. */
public final class GroovyConsoleWorker {
    private static final int LIMIT = 32768;

    public static void main(String[] arguments) throws Exception {
        if (arguments.length == 0) {
            serve(new GroovyShell(new Binding()));
            return;
        }
        if (arguments.length != 1) throw new IllegalArgumentException("Invalid Groovy project loader.");
        var entries = Files.readAllLines(Path.of(arguments[0]), StandardCharsets.UTF_8);
        if (entries.isEmpty() || entries.size() > 120) throw new IllegalArgumentException("Invalid Groovy project classpath.");
        var urls = new URL[entries.size()];
        for (int i = 0; i < entries.size(); i++) urls[i] = Path.of(entries.get(i)).toUri().toURL();
        var thread = Thread.currentThread();
        var original = thread.getContextClassLoader();
        try (var loader = new URLClassLoader(urls, GroovyShell.class.getClassLoader())) {
            thread.setContextClassLoader(loader);
            Grape.setEnableGrapes(false);
            serve(new GroovyShell(loader, new Binding()));
        } finally {
            thread.setContextClassLoader(original);
        }
    }

    private static void serve(GroovyShell shell) throws Exception {
        var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        var protocol = new PrintStream(System.out, false, StandardCharsets.UTF_8);
        System.setIn(InputStream.nullInputStream());
        protocol.println("READY\t" + GroovySystem.getVersion());
        protocol.flush();
        for (String line; (line = input.readLine()) != null;) {
            String[] request = line.split("\t", -1);
            if (request.length != 4 || !request[0].equals("EVAL") || !request[1].matches("[1-9][0-9]{0,2}")) {
                throw new IllegalArgumentException("Invalid Groovy console request.");
            }
            execute(shell, protocol, request[1], decode(request[2]), decode(request[3]));
        }
    }

    private static String decode(String input) {
        return new String(Base64.getDecoder().decode(input), StandardCharsets.UTF_8);
    }

    private static String encode(String input) {
        return Base64.getEncoder().encodeToString(input.getBytes(StandardCharsets.UTF_8));
    }

    private static String bounded(String input) {
        return input.length() <= LIMIT ? input : input.substring(0, LIMIT);
    }

    private static void execute(GroovyShell shell, PrintStream protocol, String id, String source, String file) {
        var stdout = new Capture();
        var stderr = new Capture();
        var originalOut = System.out;
        var originalErr = System.err;
        String status = "ok", value = "", error = "";
        int line = 0, column = 0;
        try (var out = new PrintStream(stdout, false, StandardCharsets.UTF_8);
             var err = new PrintStream(stderr, false, StandardCharsets.UTF_8)) {
            System.setOut(out);
            System.setErr(err);
            Object calculated = shell.evaluate(source, file);
            if (calculated != null) value = String.valueOf(calculated);
        } catch (Throwable problem) {
            status = "error";
            error = problem.getClass().getSimpleName() + ": " + String.valueOf(problem.getMessage());
            if (problem instanceof MultipleCompilationErrorsException compiler) {
                var messages = compiler.getErrorCollector().getErrors();
                if (messages != null) {
                    for (var message : messages) {
                        if (message instanceof SyntaxErrorMessage syntax) {
                            var location = syntax.getCause();
                            line = Math.max(0, location.getStartLine());
                            column = Math.max(0, location.getStartColumn());
                            error = location.getOriginalMessage();
                            break;
                        }
                    }
                }
            }
        } finally {
            System.setOut(originalOut);
            System.setErr(originalErr);
        }
        boolean truncated = stdout.truncated || stderr.truncated || value.length() > LIMIT || error.length() > LIMIT;
        protocol.println(String.join("\t", "RESULT", id, status, Integer.toString(line), Integer.toString(column),
            Boolean.toString(truncated), encode(stdout.text()), encode(stderr.text()), encode(bounded(value)), encode(bounded(error))));
        protocol.flush();
    }

    private static final class Capture extends OutputStream {
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        boolean truncated;

        @Override public synchronized void write(int value) {
            if (bytes.size() < LIMIT) bytes.write(value);
            else truncated = true;
        }

        @Override public synchronized void write(byte[] data, int offset, int count) {
            int accepted = Math.min(count, LIMIT - bytes.size());
            if (accepted > 0) bytes.write(data, offset, accepted);
            if (accepted < count) truncated = true;
        }

        synchronized String text() {
            return bytes.toString(StandardCharsets.UTF_8);
        }
    }
}
