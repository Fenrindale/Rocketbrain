package rocketbrain.signature;

import java.util.*;
import java.util.regex.Pattern;
import javax.lang.model.element.*;
import javax.lang.model.util.Elements;
import com.sun.source.tree.MethodTree;
import com.sun.source.util.Trees;
import static rocketbrain.signature.SignatureInspector.object;

/** Javac's classpath symbols are read with annotation processing and generation disabled. */
final class GroovyJavaMembers {
    static List<Map<String,Object>> inspect(Elements elements, Trees trees, String receiver, String prefix) {
        TypeElement type = elements.getTypeElement(receiver);
        if (type == null || !type.getQualifiedName().contentEquals(receiver) ||
                !type.getModifiers().contains(Modifier.PUBLIC) || type.getNestingKind() != NestingKind.TOP_LEVEL ||
                !type.getTypeParameters().isEmpty()) return List.of();
        var found = new ArrayList<Map<String,Object>>();
        for (var candidate : type.getEnclosedElements()) {
            if (!(candidate instanceof ExecutableElement method) || method.getKind() != ElementKind.METHOD ||
                    !method.getModifiers().contains(Modifier.PUBLIC) || method.getModifiers().contains(Modifier.STATIC) ||
                    !method.getTypeParameters().isEmpty() || !method.getSimpleName().toString().startsWith(prefix) ||
                    !method.getSimpleName().toString().matches("[A-Za-z_$][A-Za-z0-9_$]*")) continue;
            var report = object("name", method.getSimpleName().toString(), "owner", receiver,
                "key", SignatureInspector.key(method), "returnType", method.getReturnType().toString(),
                "parameters", method.getParameters().stream().map(parameter -> parameter.asType().toString()).toList());
            var declaration = declaration(method, trees);
            if (declaration != null) report.put("declaration", declaration);
            found.add(report);
            if (found.size() > 120) throw new IllegalArgumentException("Narrow the Groovy member prefix.");
        }
        found.sort(Comparator.comparing(member -> (String) member.get("key")));
        return found;
    }

    private static Map<String,Object> declaration(ExecutableElement method, Trees trees) {
        var path = trees.getPath(method);
        if (path == null || !(path.getLeaf() instanceof MethodTree declaration) || declaration.getReturnType() == null) return null;
        var unit = path.getCompilationUnit();
        var positions = trees.getSourcePositions();
        long start = positions.getEndPosition(unit, declaration.getReturnType());
        long end = positions.getEndPosition(unit, declaration);
        if (start < 0 || end < start) return null;
        try {
            var text = unit.getSourceFile().getCharContent(true);
            if (end > text.length()) return null;
            var name = method.getSimpleName().toString();
            var matcher = Pattern.compile("^\\s*(" + Pattern.quote(name) + ")(?=\\s*\\()")
                .matcher(text.subSequence((int) start, (int) Math.min(end, start + 512)));
            if (!matcher.find()) return null;
            return object("uri", unit.getSourceFile().toUri().toString(),
                "start", start + matcher.start(1), "end", start + matcher.end(1));
        } catch (java.io.IOException error) {
            return null;
        }
    }
}
