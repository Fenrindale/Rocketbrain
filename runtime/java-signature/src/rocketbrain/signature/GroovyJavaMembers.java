package rocketbrain.signature;

import java.io.IOException;
import java.util.*;
import java.util.regex.Pattern;
import javax.lang.model.element.*;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.util.Elements;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.StandardLocation;
import com.sun.source.tree.MethodTree;
import com.sun.source.util.Trees;
import static rocketbrain.signature.SignatureInspector.object;

/** Javac's classpath symbols are read with annotation processing and generation disabled. */
final class GroovyJavaMembers {
    static Map<String,Object> receiver(Elements elements, Trees trees, JavaFileManager files, String owner, String strategy)
            throws IOException {
        TypeElement type = elements.getTypeElement(owner);
        if (type == null || !type.getQualifiedName().contentEquals(owner) || type.getKind() != ElementKind.CLASS ||
                type.getNestingKind() != NestingKind.TOP_LEVEL || !type.getTypeParameters().isEmpty() ||
                !type.getModifiers().contains(Modifier.PUBLIC) || type.getModifiers().contains(Modifier.ABSTRACT)) return null;
        List<ExecutableElement> candidates;
        if (strategy.equals("constructor")) {
            candidates = type.getEnclosedElements().stream().filter(e -> e.getKind() == ElementKind.CONSTRUCTOR)
                .map(e -> (ExecutableElement) e).filter(GroovyJavaMembers::acceptsNoArguments).toList();
        } else if (strategy.startsWith("factory:") && type.getModifiers().contains(Modifier.FINAL) &&
                   type.getSuperclass().toString().equals("java.lang.Object") && type.getInterfaces().isEmpty()) {
            String factory = strategy.substring("factory:".length());
            candidates = type.getEnclosedElements().stream()
                .filter(e -> e.getKind() == ElementKind.METHOD && e.getSimpleName().contentEquals(factory))
                .map(e -> (ExecutableElement) e).filter(GroovyJavaMembers::acceptsNoArguments).toList();
        } else return null;
        if (candidates.size() != 1) return null;
        var initializer = candidates.getFirst();
        if (!initializer.getModifiers().contains(Modifier.PUBLIC) || !initializer.getParameters().isEmpty() ||
                !initializer.getTypeParameters().isEmpty()) return null;
        if (!strategy.equals("constructor") && (!initializer.getModifiers().contains(Modifier.STATIC) ||
                !(initializer.getReturnType() instanceof DeclaredType returnType) || !returnType.asElement().equals(type))) return null;
        var declaration = trees.getPath(type);
        var origin = files.getJavaFileForInput(StandardLocation.CLASS_PATH, owner, JavaFileObject.Kind.CLASS);
        return object("key", SignatureInspector.key(initializer), "source",
            declaration == null ? null : declaration.getCompilationUnit().getSourceFile().toUri().toString(),
            "classFile", origin == null ? null : origin.toUri().toString());
    }

    private static boolean acceptsNoArguments(ExecutableElement method) {
        return method.getParameters().isEmpty() || method.isVarArgs() && method.getParameters().size() == 1;
    }

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
