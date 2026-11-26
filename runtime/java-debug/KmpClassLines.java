import java.io.PrintStream;
import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.attribute.LineNumberInfo;
import java.lang.classfile.attribute.LineNumberTableAttribute;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.stream.Collectors;

/** Inspects selected Kotlin JVM output bytes without loading project classes. */
public final class KmpClassLines {
    public static void main(String[] args) throws Exception {
        System.setOut(new PrintStream(System.out, false, StandardCharsets.UTF_8));
        var inputs = Files.readAllLines(Path.of(args[0]), StandardCharsets.UTF_8);
        if (inputs.size() > 1200) throw new IllegalArgumentException("Kotlin class-file limit.");
        int entries = 0;
        var digest = MessageDigest.getInstance("SHA-256");
        for (int i = 0; i < inputs.size(); i++) {
            var file = Path.of(new String(Base64.getDecoder().decode(inputs.get(i)), StandardCharsets.UTF_8));
            if (Files.size(file) > 512 * 1024) throw new IllegalArgumentException("Kotlin class-file byte limit.");
            var model = ClassFile.of().parse(file);
            var name = model.findAttribute(Attributes.sourceFile()).map(attr -> attr.sourceFile().stringValue()).orElse("");
            if (!name.endsWith(".kt")) continue;
            var debug = model.findAttribute(Attributes.sourceDebugExtension()).map(attr -> attr.contents()).orElse(new byte[0]);
            if (debug.length > 96 * 1024) throw new IllegalArgumentException("Kotlin source map byte limit.");
            row("class", i, model.thisClass().asInternalName(), name, Base64.getEncoder().encodeToString(debug));
            for (var method : model.methods()) {
                var attr = method.findAttribute(Attributes.code());
                if (attr.isEmpty()) continue;
                var code = attr.get();
                var lines = code.findAttributes(Attributes.lineNumberTable()).stream()
                        .map(LineNumberTableAttribute::lineNumbers).flatMap(java.util.List::stream).toList();
                if (lines.isEmpty()) continue;
                entries += lines.size();
                if (entries > 40000) throw new IllegalArgumentException("Kotlin executable line limit.");
                String indexes = lines.stream().map(KmpClassLines::entry).collect(Collectors.joining(","));
                row("method", i, method.methodName().stringValue(), method.methodType().stringValue(),
                        HexFormat.of().formatHex(digest.digest(code.codeArray())), indexes);
            }
        }
    }

    private static String entry(LineNumberInfo info) {
        return info.startPc() + ":" + info.lineNumber();
    }

    private static void row(Object... parts) {
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) System.out.print('\t');
            String part = parts[i].toString();
            if (part.chars().anyMatch(code -> code < 32 || code == 127)) throw new IllegalArgumentException("Invalid Kotlin class data.");
            System.out.print(part);
        }
        System.out.println();
    }
}
