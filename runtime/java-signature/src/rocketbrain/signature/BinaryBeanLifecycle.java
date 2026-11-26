package rocketbrain.signature;

import java.io.File;
import java.io.IOException;
import java.lang.classfile.Annotation;
import java.lang.classfile.AnnotationValue;
import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.MethodModel;
import java.lang.reflect.AccessFlag;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.jar.JarFile;
import java.util.regex.Pattern;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.util.Elements;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.StandardLocation;

import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import static rocketbrain.signature.SignatureInspector.object;

/** Inspects exact attributed source uses and dependency bytes, without loading annotation definitions. */
final class BinaryBeanLifecycle {
    private static final String BEAN_NAME = "org.springframework.context.annotation.Bean";
    private static final String ALIAS_NAME = "org.springframework.core.annotation.AliasFor";
    private static final String BEAN = "Lorg/springframework/context/annotation/Bean;";
    private static final String ALIAS = "Lorg/springframework/core/annotation/AliasFor;";
    private static final String RETENTION = "Ljava/lang/annotation/Retention;";
    private static final Set<String> STANDARD_META = Set.of(RETENTION, "Ljava/lang/annotation/Target;",
        "Ljava/lang/annotation/Documented;", "Ljava/lang/annotation/Inherited;");
    private static final Set<String> LIFECYCLE = Set.of("initMethod", "destroyMethod");
    private static final String STRING_METHOD = "()Ljava/lang/String;";
    private static final Pattern METHOD_NAME = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]{0,127}");
    private static final Pattern CLASS_NAME = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)+");
    private static final int MAX_BYTES = 256 * 1024, MAX_USES = 64, MAX_MEMBERS = 24;

    private record Input(int archive, String entry, String sha256, ClassModel model) {
        Map<String,Object> provenance() { return object("archive", archive, "entry", entry, "classSha256", sha256); }
    }
    private record Alias(String member, String target, String defaultValue) {}
    private record Contract(Input input, String state, Map<String,String> meta, List<Alias> aliases) {}
    private final Trees trees;
    private final SourcePositions positions;
    private final Elements elements;
    private final JavaFileManager files;
    private final List<Path> classpath;
    private final Map<String,Contract> contracts = new HashMap<>();
    private final List<Map<String,Object>> uses = new ArrayList<>();
    private boolean limited;
    private Input bean, aliasFor;

    BinaryBeanLifecycle(Trees trees, Elements elements, JavaFileManager files, String classpath) {
        this.trees = trees;
        this.positions = trees.getSourcePositions();
        this.elements = elements;
        this.files = files;
        this.classpath = classpath.isEmpty() ? List.of() :
            Arrays.stream(classpath.split(Pattern.quote(File.pathSeparator))).map(Path::of).toList();
    }

    Map<String,Object> inspect(List<CompilationUnitTree> units, String ownerName) {
        for (CompilationUnitTree unit : units) {
            new TreePathScanner<Void,Void>() {
                @Override public Void visitMethod(MethodTree method, Void ignored) {
                    if (trees.getElement(getCurrentPath()) instanceof ExecutableElement factory &&
                            factory.getKind() == ElementKind.METHOD && factory.getReturnType() instanceof DeclaredType declared &&
                            declared.getTypeArguments().isEmpty() && declared.asElement() instanceof TypeElement owner &&
                            owner.getQualifiedName().contentEquals(ownerName) && trees.getPath(owner) != null) {
                        for (AnnotationTree annotation : method.getModifiers().getAnnotations()) {
                            if (uses.size() >= MAX_USES) { limited = true; break; }
                            record(unit, annotation);
                        }
                    }
                    return super.visitMethod(method, ignored);
                }
            }.scan(unit, null);
        }
        return object("uses", uses, "limitReached", limited,
            "springBean", bean == null ? Map.of() : bean.provenance(),
            "springAliasFor", aliasFor == null ? Map.of() : aliasFor.provenance());
    }

    private void record(CompilationUnitTree unit, AnnotationTree tree) {
        TreePath typePath = TreePath.getPath(unit, tree.getAnnotationType());
        if (typePath == null || !(trees.getElement(typePath) instanceof TypeElement type) ||
            type.getKind() != ElementKind.ANNOTATION_TYPE || trees.getPath(type) != null) return;
        String name = elements.getBinaryName(type).toString();
        if (!CLASS_NAME.matcher(name).matches() || name.equals(BEAN_NAME) || name.startsWith("java.") ||
            name.startsWith("jakarta.") || name.startsWith("javax.") || name.startsWith("org.springframework.")) return;
        long start = positions.getStartPosition(unit, tree), end = positions.getEndPosition(unit, tree);
        if (start < 0 || end <= start || end - start > 4096 || contracts.size() >= MAX_USES) {
            limited = true;
            return;
        }
        Contract contract = contracts.computeIfAbsent(name, this::inspectContract);
        if (contract.state().equals("unrelated")) return;
        Map<String,Object> result = new LinkedHashMap<>(object("name", name, "uri", unit.getSourceFile().toUri().toString(),
            "start", start, "end", end, "state", contract.state()));
        if (contract.input() != null) result.put("provenance", contract.input().provenance());
        if (contract.state().equals("reviewed")) {
            try { result.put("values", values(tree, contract)); }
            catch (IllegalArgumentException unsupported) { result.put("state", "unsupported-source-value"); }
        }
        uses.add(result);
    }

    private Contract inspectContract(String name) {
        Input binary = null;
        try {
            binary = exactClass(name);
            ClassModel model = binary.model();
            require(model.flags().has(AccessFlag.ANNOTATION));
            var decorations = model.findAttribute(Attributes.runtimeVisibleAnnotations()).stream()
                .flatMap(attribute -> attribute.annotations().stream()).toList();
            var beanDecorations = decorations.stream().filter(item -> item.className().equalsString(BEAN)).toList();
            if (beanDecorations.isEmpty()) {
                // Additional meta-annotation chains are not inferred from unselected binaries.
                String state = decorations.stream().allMatch(item -> STANDARD_META.contains(item.className().stringValue()))
                    ? "unrelated" : "unsupported-meta-chain";
                return new Contract(binary, state, Map.of(), List.of());
            }
            require(beanDecorations.size() == 1 && decorations.stream().allMatch(item ->
                item.className().equalsString(BEAN) || STANDARD_META.contains(item.className().stringValue())));
            require(decorations.stream().filter(item -> item.className().equalsString(RETENTION)).count() == 1 &&
                decorations.stream().filter(item -> item.className().equalsString(RETENTION)).anyMatch(item ->
                    attributes(item).get("value") instanceof AnnotationValue.OfEnum value &&
                    value.className().equalsString("Ljava/lang/annotation/RetentionPolicy;") && value.constantName().equalsString("RUNTIME")));
            if (bean == null) {
                Input checked = exactClass(BEAN_NAME);
                require(checked.model().flags().has(AccessFlag.ANNOTATION));
                bean = checked;
            }
            var beanMeta = attributes(beanDecorations.getFirst());
            Map<String,String> metadata = new LinkedHashMap<>();
            for (String property : List.of("initMethod", "destroyMethod")) {
                MethodModel member = requiredMember(bean.model(), property, STRING_METHOD);
                var value = beanMeta.containsKey(property) ? beanMeta.get(property) : defaultValue(member);
                metadata.put(property, lifecycle(value));
            }
            require(model.methods().size() <= MAX_MEMBERS);
            List<Alias> aliases = new ArrayList<>();
            for (MethodModel method : model.methods()) {
                List<Annotation> annotations = method.findAttribute(Attributes.runtimeVisibleAnnotations()).stream()
                    .flatMap(attribute -> attribute.annotations().stream()).toList();
                if (annotations.isEmpty()) continue;
                require(annotations.size() == 1 && annotations.getFirst().className().equalsString(ALIAS));
                if (aliasFor == null) {
                    Input checked = exactClass(ALIAS_NAME);
                    require(checked.model().flags().has(AccessFlag.ANNOTATION));
                    requiredMember(checked.model(), "annotation", "()Ljava/lang/Class;");
                    requiredMember(checked.model(), "attribute", STRING_METHOD);
                    requiredMember(checked.model(), "value", STRING_METHOD);
                    aliasFor = checked;
                }
                var specification = attributes(annotations.getFirst());
                require(Set.of("annotation", "attribute", "value").containsAll(specification.keySet()) &&
                    specification.get("annotation") instanceof AnnotationValue.OfClass target &&
                    target.className().equalsString(BEAN) &&
                    !(specification.containsKey("attribute") && specification.containsKey("value")));
                String source = method.methodName().stringValue();
                String target = specification.containsKey("attribute") ? string(specification.get("attribute")) :
                    specification.containsKey("value") ? string(specification.get("value")) : source;
                if (target.equals("name") || target.equals("value")) continue;
                require(LIFECYCLE.contains(target) && METHOD_NAME.matcher(source).matches() &&
                    method.methodType().equalsString(STRING_METHOD) && aliases.stream().noneMatch(item -> item.target().equals(target)));
                AnnotationValue fallback = defaultValue(method);
                aliases.add(new Alias(source, target, fallback == null ? null : lifecycle(fallback)));
            }
            return new Contract(binary, "reviewed", metadata, List.copyOf(aliases));
        } catch (IOException failure) {
            return new Contract(binary, "unverified-binary-origin", Map.of(), List.of());
        } catch (IllegalArgumentException failure) {
            return new Contract(binary, "unsupported-binary-contract", Map.of(), List.of());
        }
    }

    private static List<Map<String,Object>> values(AnnotationTree use, Contract contract) {
        var supplied = new LinkedHashMap<String,com.sun.source.tree.ExpressionTree>();
        for (var argument : use.getArguments()) {
            String member = argument instanceof AssignmentTree assignment ? assignment.getVariable().toString() : "value";
            var value = argument instanceof AssignmentTree assignment ? assignment.getExpression() : argument;
            require(supplied.putIfAbsent(member, value) == null);
        }
        List<Map<String,Object>> result = new ArrayList<>();
        for (Alias alias : contract.aliases()) {
            if (supplied.containsKey(alias.member())) {
                require(supplied.get(alias.member()) instanceof LiteralTree literal && literal.getValue() instanceof String);
                String value = (String)((LiteralTree)supplied.get(alias.member())).getValue();
                addValue(result, alias.target(), safeLifecycle(value), "source-alias", alias.member());
            } else if (alias.defaultValue() != null) {
                addValue(result, alias.target(), alias.defaultValue(), "binary-alias-default", alias.member());
            }
        }
        // Keep the base value as separate protection when Spring has a non-default meta value.
        for (var item : contract.meta().entrySet()) addValue(result, item.getKey(), item.getValue(), "binary-meta", "");
        return List.copyOf(result);
    }

    private static void addValue(List<Map<String,Object>> values, String target, String value, String origin, String member) {
        if (!value.isEmpty() && !value.equals("(inferred)")) {
            values.add(object("attribute", target, "name", value, "origin", origin, "member", member));
        }
    }

    private Input exactClass(String name) throws IOException {
        TypeElement type = elements.getTypeElement(name);
        if (type == null || trees.getPath(type) != null || type.getKind() != ElementKind.ANNOTATION_TYPE) {
            throw new IOException("Unverified annotation binding.");
        }
        String binary = elements.getBinaryName(type).toString(), entry = binary.replace('.', '/') + ".class";
        int found = -1;
        byte[] bytes = null;
        for (int index = 0; index < classpath.size(); index++) {
            Path input = classpath.get(index);
            if (Files.isDirectory(input)) {
                if (Files.exists(input.resolve(entry))) throw new IOException("Competing directory annotation.");
                continue;
            }
            try (JarFile jar = new JarFile(input.toFile(), false, JarFile.OPEN_READ, Runtime.version())) {
                var record = jar.getJarEntry(entry);
                if (record == null) continue;
                if (found >= 0 || !record.getRealName().equals(entry) || record.getSize() > MAX_BYTES) {
                    throw new IOException("Competing, versioned or oversized binary annotation.");
                }
                try (var stream = jar.getInputStream(record)) { bytes = stream.readNBytes(MAX_BYTES + 1); }
                if (bytes.length != record.getSize() || bytes.length > MAX_BYTES) throw new IOException("Unbounded annotation class.");
                found = index;
            }
        }
        JavaFileObject actual = files.getJavaFileForInput(StandardLocation.CLASS_PATH, binary, JavaFileObject.Kind.CLASS);
        URI uri = actual == null ? null : actual.toUri();
        if (found < 0 || uri == null || !"jar".equals(uri.getScheme())) throw new IOException("Missing verified annotation archive.");
        String location = uri.getRawSchemeSpecificPart();
        int separator = location.lastIndexOf("!/");
        if (separator < 0 || !location.substring(separator + 2).equals(entry) ||
                !Path.of(URI.create(location.substring(0, separator))).toRealPath().equals(classpath.get(found).toRealPath())) {
            throw new IOException("Attributed annotation origin did not match its archive.");
        }
        var model = ClassFile.of().parse(bytes);
        require(model.thisClass().asInternalName().concat(".class").equals(entry));
        String sha;
        try { sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
        return new Input(found, entry, sha, model);
    }

    private static Map<String,AnnotationValue> attributes(Annotation annotation) {
        Map<String,AnnotationValue> values = new LinkedHashMap<>();
        for (var item : annotation.elements()) require(values.putIfAbsent(item.name().stringValue(), item.value()) == null);
        return values;
    }

    private static MethodModel requiredMember(ClassModel type, String name, String descriptor) {
        var matches = type.methods().stream().filter(method -> method.methodName().equalsString(name)).toList();
        require(matches.size() == 1 && matches.getFirst().methodType().equalsString(descriptor));
        return matches.getFirst();
    }

    private static AnnotationValue defaultValue(MethodModel method) {
        return method.findAttribute(Attributes.annotationDefault()).map(attribute -> attribute.defaultValue()).orElse(null);
    }

    private static String string(AnnotationValue value) {
        if (value instanceof AnnotationValue.OfString text) return text.stringValue();
        throw new IllegalArgumentException("Unsupported annotation value.");
    }

    private static String lifecycle(AnnotationValue value) { return safeLifecycle(string(value)); }

    private static String safeLifecycle(String value) {
        require(value.isEmpty() || value.equals("(inferred)") || METHOD_NAME.matcher(value).matches());
        return value;
    }

    private static void require(boolean condition) {
        if (!condition) throw new IllegalArgumentException("Unsupported binary Bean lifecycle metadata.");
    }
}
