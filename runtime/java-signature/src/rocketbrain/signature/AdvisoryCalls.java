package rocketbrain.signature;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.jar.JarFile;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.StandardLocation;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import static rocketbrain.signature.SignatureInspector.object;

/** Records attributed call sites only and never loads or executes the inspected dependencies. */
final class AdvisoryCalls {
    private record Target(String owner, String name, String returns, boolean isStatic) {}
    private record Origin(String state, int archive) {}
    private final Trees trees;
    private final SourcePositions positions;
    private final Elements elements;
    private final Types types;
    private final JavaFileManager files;
    private final List<Path> classpath;
    private final List<Target> targets;
    private final Map<String,Origin> origins = new HashMap<>();
    private final Map<Target,Integer> indices = new HashMap<>();
    private final List<Map<String,Object>> uses = new ArrayList<>();
    private int omitted;

    AdvisoryCalls(Trees trees, Elements elements, Types types, JavaFileManager files, String classpath, List<String> raw) {
        this.trees = trees;
        this.positions = trees.getSourcePositions();
        this.elements = elements;
        this.types = types;
        this.files = files;
        this.classpath = classpath.isEmpty() ? List.of() :
            Arrays.stream(classpath.split(java.util.regex.Pattern.quote(File.pathSeparator))).map(Path::of).toList();
        this.targets = raw.stream().map(value -> {
            String[] parts = value.split("\t",-1);
            if (parts.length != 4 || !(parts[3].equals("static") || parts[3].equals("instance"))) {
                throw new IllegalArgumentException("Invalid supported advisory signature.");
            }
            return new Target(parts[0], parts[1], parts[2], parts[3].equals("static"));
        }).toList();
        for (int index = 0; index < targets.size(); index++) indices.put(targets.get(index), index);
    }

    private Origin locate(String name) throws IOException {
        TypeElement owner = elements.getTypeElement(name);
        if (owner == null) return new Origin("unresolved", -1);
        if (trees.getPath(owner) != null) return new Origin("source-shadowed", -1);
        String binaryName = elements.getBinaryName(owner).toString();
        String entry = binaryName.replace('.', '/') + ".class";
        int source = -1;
        for (int index = 0; index < classpath.size(); index++) {
            Path item = classpath.get(index);
            boolean contains;
            if (Files.isDirectory(item)) contains = Files.isRegularFile(item.resolve(entry));
            else {
                try (JarFile jar = new JarFile(item.toFile(),false,JarFile.OPEN_READ,Runtime.version())) {
                    contains = jar.getJarEntry(entry) != null;
                }
            }
            if (!contains) continue;
            if (source >= 0) return new Origin("duplicate-owner", -1);
            source = index;
        }
        if (source < 0 || Files.isDirectory(classpath.get(source))) return new Origin("unverified-origin", -1);
        JavaFileObject boundClass = files.getJavaFileForInput(StandardLocation.CLASS_PATH,binaryName,JavaFileObject.Kind.CLASS);
        URI uri = boundClass == null ? null : boundClass.toUri();
        if (uri == null || !"jar".equals(uri.getScheme())) return new Origin("unverified-origin", -1);
        String value = uri.getRawSchemeSpecificPart();
        int separator = value.lastIndexOf("!/");
        if (separator < 0 || !Path.of(URI.create(value.substring(0,separator))).toRealPath().equals(classpath.get(source).toRealPath())) {
            return new Origin("unverified-origin", -1);
        }
        return new Origin("archive",source);
    }

    Map<String,Object> inspect(List<CompilationUnitTree> units) throws IOException {
        for (Target target : targets) {
            if (!origins.containsKey(target.owner())) origins.put(target.owner(),locate(target.owner()));
        }
        for (CompilationUnitTree unit : units) {
            String uri = unit.getSourceFile().toUri().toString();
            new TreePathScanner<Void,Void>() {
                private void occurrence(Tree node, String kind) {
                    if (!(trees.getElement(getCurrentPath()) instanceof ExecutableElement method) ||
                        method.getKind() != ElementKind.METHOD || !method.getParameters().isEmpty() ||
                        !(method.getEnclosingElement() instanceof TypeElement owner)) return;
                    Target key = new Target(owner.getQualifiedName().toString(),method.getSimpleName().toString(),
                        types.erasure(method.getReturnType()).toString(),method.getModifiers().contains(Modifier.STATIC));
                    Integer index = indices.get(key);
                    if (index == null || !origins.get(key.owner()).state().equals("archive")) return;
                    long start = positions.getStartPosition(unit,node), end = positions.getEndPosition(unit,node);
                    if (start < 0 || end <= start || end-start > 4096) return;
                    if (uses.size() >= 2000) { omitted++; return; }
                    uses.add(object("target",index,"uri",uri,"start",start,"end",end,"kind",kind));
                }
                @Override
                public Void visitMethodInvocation(MethodInvocationTree tree, Void ignored) {
                    occurrence(tree,"call");
                    return super.visitMethodInvocation(tree,ignored);
                }
                @Override
                public Void visitMemberReference(MemberReferenceTree tree, Void ignored) {
                    occurrence(tree,"method reference");
                    return super.visitMemberReference(tree,ignored);
                }
            }.scan(unit,null);
        }
        return object("bindings",targets.stream().map(target -> {
            Origin origin = origins.get(target.owner());
            return object("state",origin.state(),"archive",origin.archive());
        }).toList(),"uses",uses,"omitted",omitted);
    }
}
