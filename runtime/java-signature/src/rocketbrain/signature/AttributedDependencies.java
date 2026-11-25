package rocketbrain.signature;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import static rocketbrain.signature.SignatureInspector.key;
import static rocketbrain.signature.SignatureInspector.object;

/** Reports statically bound uses of types defined in the supplied source packet. */
final class AttributedDependencies {
    private record Target(String uri, String packageName, String type, long declaration) {}
    private final Trees trees;
    private final SourcePositions positions;
    private final Set<String> sources;
    private final Map<TypeElement,Optional<Target>> targets = new HashMap<>();
    private final List<Map<String,Object>> references = new ArrayList<>();
    private int omitted;

    AttributedDependencies(Trees trees, Set<String> sources) {
        this.trees = trees;
        this.positions = trees.getSourcePositions();
        this.sources = sources;
    }

    private static String packageOf(CompilationUnitTree unit) {
        return unit.getPackageName() == null ? "" : unit.getPackageName().toString();
    }

    private Optional<Target> sourceTarget(TypeElement element) {
        String name = element.getQualifiedName().toString();
        TreePath path = trees.getPath(element);
        if (path == null || name.isEmpty()) return Optional.empty();
        CompilationUnitTree file = path.getCompilationUnit();
        String uri = file.getSourceFile().toUri().toString();
        long start = positions.getStartPosition(file,path.getLeaf());
        return sources.contains(uri) && start >= 0 ? Optional.of(new Target(uri,packageOf(file),name,start)) : Optional.empty();
    }

    Map<String,Object> inspect(List<CompilationUnitTree> units) {
        for (CompilationUnitTree unit : units) {
            String uri = unit.getSourceFile().toUri().toString(), packageName = packageOf(unit);
            new TreePathScanner<Void,Void>() {
                private final Set<String> emitted = new HashSet<>();
                private int occurrences;

                private void occurrence(Tree tree, TypeElement element, String kind, String symbol) {
                    Optional<Target> found = targets.computeIfAbsent(element,AttributedDependencies.this::sourceTarget);
                    if (found.isEmpty() || found.get().uri().equals(uri)) return;
                    Target target = found.get();
                    long start = positions.getStartPosition(unit,tree), end = positions.getEndPosition(unit,tree);
                    if (start < 0 || end <= start || end-start > 4096) return;
                    String identity = start+":"+end+":"+kind+":"+symbol;
                    if (emitted.contains(identity)) return;
                    if (occurrences >= 750 || references.size() >= 9000) { omitted++; return; }
                    emitted.add(identity);
                    occurrences++;
                    references.add(object("uri",uri,"start",start,"end",end,"packageName",packageName,"kind",kind,
                        "symbol",symbol,"targetUri",target.uri(),"targetPackage",target.packageName(),
                        "targetType",target.type(),"declaration",target.declaration()));
                }

                private void namedUse(Tree node) {
                    Element element = trees.getElement(getCurrentPath());
                    if (element instanceof TypeElement type) {
                        occurrence(node,type,"type reference",type.getQualifiedName().toString());
                    } else if (element instanceof VariableElement field &&
                        Set.of(ElementKind.FIELD,ElementKind.ENUM_CONSTANT).contains(field.getKind()) &&
                        field.getEnclosingElement() instanceof TypeElement type) {
                        occurrence(node,type,"field reference",type.getQualifiedName()+"#"+field.getSimpleName());
                    }
                }

                private void executableUse(Tree node, String kind) {
                    if (trees.getElement(getCurrentPath()) instanceof ExecutableElement method &&
                        method.getEnclosingElement() instanceof TypeElement type) {
                        occurrence(node,type,kind,key(method));
                    }
                }

                @Override public Void visitImport(ImportTree node, Void unused) { return null; }

                @Override public Void visitIdentifier(IdentifierTree node, Void unused) {
                    namedUse(node);
                    return super.visitIdentifier(node,unused);
                }

                @Override public Void visitMemberSelect(MemberSelectTree node, Void unused) {
                    namedUse(node);
                    return super.visitMemberSelect(node,unused);
                }

                @Override public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
                    executableUse(node.getMethodSelect(),"method call");
                    return super.visitMethodInvocation(node,unused);
                }

                @Override public Void visitNewClass(NewClassTree node, Void unused) {
                    executableUse(node.getIdentifier(),"constructor call");
                    return super.visitNewClass(node,unused);
                }

                @Override public Void visitMemberReference(MemberReferenceTree node, Void unused) {
                    executableUse(node,"method reference");
                    return super.visitMemberReference(node,unused);
                }
            }.scan(unit,null);
        }
        return object("references",references,"omitted",omitted);
    }
}
