package rocketbrain.signature;

import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewArrayTree;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.NestingKind;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeKind;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.StandardLocation;
import static rocketbrain.signature.SignatureInspector.object;

/** Binds literal Spring resource use and the selected member without loading project classes. */
final class SpringResourceImports {
    private static final String IMPORT_RESOURCE = "org.springframework.context.annotation.ImportResource";
    private static final String ANNOTATION_ENTRY = IMPORT_RESOURCE.replace('.', '/') + ".class";
    private static final int MAX_USES = 64, MAX_LOCATIONS = 16;

    private final Trees trees;
    private final SourcePositions positions;
    private final JavaFileManager files;
    private final List<Path> classpath;

    SpringResourceImports(Trees trees, JavaFileManager files, String classpath) {
        this.trees = trees;
        this.positions = trees.getSourcePositions();
        this.files = files;
        this.classpath = classpath.isEmpty() ? List.of() :
            Arrays.stream(classpath.split(Pattern.quote(File.pathSeparator))).map(Path::of).toList();
    }

    Map<String, Object> inspect(List<CompilationUnitTree> units, String uri, int offset, String name) throws IOException {
        List<Map<String, Object>> uses = new ArrayList<>();
        List<Map<String, Object>> targets = new ArrayList<>();
        for (CompilationUnitTree unit : units) {
            String sourceUri = unit.getSourceFile().toUri().toString();
            String source = sourceUri.equals(uri) ? unit.getSourceFile().getCharContent(false).toString() : "";
            new TreePathScanner<Void, Void>() {
                @Override public Void visitClass(ClassTree tree, Void ignored) {
                    if (getCurrentPath().getParentPath().getLeaf() instanceof CompilationUnitTree &&
                            uses.size() <= MAX_USES) {
                        for (AnnotationTree annotation : tree.getModifiers().getAnnotations()) {
                            var use = resourceUse(unit, annotation);
                            if (use != null) uses.add(use);
                            if (uses.size() > MAX_USES) break;
                        }
                    }
                    return super.visitClass(tree, ignored);
                }

                @Override public Void visitMethod(MethodTree tree, Void ignored) {
                    if (sourceUri.equals(uri) && trees.getElement(getCurrentPath()) instanceof ExecutableElement method &&
                            method.getKind() == ElementKind.METHOD && method.getSimpleName().contentEquals(name) &&
                            method.getEnclosingElement() instanceof TypeElement owner && plainOwner(owner) &&
                            method.getParameters().isEmpty() && method.getModifiers().contains(Modifier.PRIVATE) &&
                            !method.getModifiers().contains(Modifier.STATIC) && method.getReturnType().getKind() == TypeKind.VOID &&
                            tree.getBody() != null && method.getAnnotationMirrors().isEmpty() &&
                            selectedMethod(unit, tree, source, offset, name)) {
                        targets.add(object("owner", owner.getQualifiedName().toString(), "name", name, "uri", sourceUri,
                            "start", offset, "end", offset + name.length(), "signature", owner.getQualifiedName() + "#" + name + "()"));
                    }
                    return super.visitMethod(tree, ignored);
                }
            }.scan(unit, null);
        }
        boolean limited = uses.size() > MAX_USES;
        return object("uses", limited ? List.of() : uses, "limitReached", limited,
            "target", targets.size() == 1 ? targets.getFirst() : Map.of(), "springArchive", archive());
    }

    private static boolean plainOwner(TypeElement owner) {
        return owner.getKind() == ElementKind.CLASS && owner.getNestingKind() == NestingKind.TOP_LEVEL &&
            owner.getModifiers().containsAll(List.of(Modifier.PUBLIC, Modifier.FINAL)) &&
            owner.getSuperclass().toString().equals("java.lang.Object") && owner.getInterfaces().isEmpty();
    }

    private boolean selectedMethod(CompilationUnitTree unit, MethodTree method, String text, int offset, String name) {
        int body = (int)positions.getStartPosition(unit, method.getBody());
        int opening = body < 0 ? -1 : text.lastIndexOf('(', body);
        int start = (int)positions.getStartPosition(unit, method);
        int cursor = opening;
        while (cursor > start && Character.isWhitespace(text.charAt(cursor - 1))) cursor--;
        return start >= 0 && offset >= start && cursor - name.length() == offset && text.startsWith(name, offset);
    }

    private Map<String,Object> resourceUse(CompilationUnitTree unit, AnnotationTree annotation) {
        TreePath binding = TreePath.getPath(unit, annotation.getAnnotationType());
        if (binding == null || !(trees.getElement(binding) instanceof TypeElement type) ||
                !type.getQualifiedName().contentEquals(IMPORT_RESOURCE) || type.getKind() != ElementKind.ANNOTATION_TYPE ||
                trees.getPath(type) != null) return null;
        long start = positions.getStartPosition(unit, annotation), end = positions.getEndPosition(unit, annotation);
        if (start < 0 || end <= start || end - start > 4096 || annotation.getArguments().size() != 1) return null;
        ExpressionTree expression = annotation.getArguments().getFirst();
        if (expression instanceof AssignmentTree assignment) {
            if (!List.of("value", "locations").contains(assignment.getVariable().toString())) return null;
            expression = assignment.getExpression();
        }
        List<? extends ExpressionTree> values = expression instanceof NewArrayTree array ? array.getInitializers() : List.of(expression);
        if (values == null || values.isEmpty() || values.size() > MAX_LOCATIONS) return null;
        List<String> locations = new ArrayList<>();
        for (ExpressionTree value : values) {
            if (!(value instanceof LiteralTree literal) || !(literal.getValue() instanceof String text) || text.length() > 208 ||
                    locations.contains(text)) return null;
            locations.add(text);
        }
        return object("uri", unit.getSourceFile().toUri().toString(), "start", start, "end", end, "locations", locations);
    }

    private int archive() throws IOException {
        JavaFileObject found = files.getJavaFileForInput(StandardLocation.CLASS_PATH, IMPORT_RESOURCE, JavaFileObject.Kind.CLASS);
        URI origin = found == null ? null : found.toUri();
        if (origin == null || !"jar".equals(origin.getScheme())) return -1;
        String location = origin.getRawSchemeSpecificPart();
        int separator = location.lastIndexOf("!/");
        if (separator < 0 || !location.substring(separator + 2).equals(ANNOTATION_ENTRY)) return -1;
        Path archive = Path.of(URI.create(location.substring(0, separator))).toRealPath();
        for (int index = 0; index < classpath.size(); index++) {
            if (archive.equals(classpath.get(index).toRealPath())) return index;
        }
        return -1;
    }
}
