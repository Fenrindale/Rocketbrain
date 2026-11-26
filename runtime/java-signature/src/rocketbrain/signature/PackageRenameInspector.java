package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.util.*;

import static rocketbrain.signature.SignatureInspector.object;

final class PackageRenameInspector {
    private final Trees trees;
    private final SourcePositions positions;
    private final Elements elements;
    private final Types types;
    private final String prefix;
    private final String other;
    private int bindingCount;

    PackageRenameInspector(JavacTask task, String prefix, String other) {
        this.trees = Trees.instance(task);
        this.positions = trees.getSourcePositions();
        this.elements = task.getElements();
        this.types = task.getTypes();
        this.prefix = prefix;
        this.other = other;
    }

    List<Map<String, Object>> inspect(List<CompilationUnitTree> units) {
        return units.stream().map(this::inspectUnit).toList();
    }

    private boolean inside(String packageName) {
        return packageName.equals(prefix) || packageName.startsWith(prefix + ".");
    }

    private Map<String, Object> inspectUnit(CompilationUnitTree unit) {
        String packageName = unit.getPackageName() == null ? "" : unit.getPackageName().toString();
        var spans = new TreeMap<Integer, Map<String, Object>>();
        var bindings = new ArrayList<List<Object>>();
        String uri = unit.getSourceFile().toUri().toString();
        String text;
        try { text = unit.getSourceFile().getCharContent(true).toString(); }
        catch (java.io.IOException error) { throw new IllegalStateException("Cannot read the attributed package source.", error); }

        new TreePathScanner<Void,Void>() {
            int start(Tree node) { return (int) positions.getStartPosition(unit, node); }
            int end(Tree node) { return (int) positions.getEndPosition(unit, node); }

            void span(Tree node, String role) {
                Tree selected = node;
                while (selected instanceof MemberSelectTree member && !selected.toString().equals(prefix)) {
                    selected = member.getExpression();
                }
                if (!selected.toString().equals(prefix)) return;
                int from = start(selected), to = end(selected);
                if (from < 0 || to > text.length() || to - from != prefix.length() ||
                    !text.regionMatches(from, prefix, 0, prefix.length())) {
                    throw new IllegalArgumentException("Use ordinary exact Java package names without escapes or interleaved trivia.");
                }
                spans.putIfAbsent(from, object("start", from, "end", to, "role", role));
                if (spans.size() > 5000) throw new IllegalArgumentException("Java package reference review exceeds its span limit.");
            }

            void binding(Tree node, Element resolved) {
                int from = start(node), to = end(node);
                if (from < 0 || to <= from || resolved == null) return;
                List<String> identity;
                if (resolved instanceof TypeElement type) {
                    identity = List.of("type", elements.getBinaryName(type).toString());
                } else if (resolved instanceof ExecutableElement member && member.getEnclosingElement() instanceof TypeElement owner) {
                    identity = new ArrayList<>(List.of("method", elements.getBinaryName(owner).toString(),
                        member.getSimpleName().toString(), types.erasure(member.getReturnType()).toString()));
                    for (var parameter : member.getParameters()) identity.add(types.erasure(parameter.asType()).toString());
                } else if (resolved instanceof VariableElement member &&
                    (member.getKind() == ElementKind.FIELD || member.getKind() == ElementKind.ENUM_CONSTANT) &&
                    member.getEnclosingElement() instanceof TypeElement owner) {
                    identity = List.of("field", elements.getBinaryName(owner).toString(), member.getSimpleName().toString(),
                        types.erasure(member.asType()).toString());
                } else return;
                if (++bindingCount > 24000) throw new IllegalArgumentException("Java package binding review exceeds its limit.");
                bindings.add(List.of(from, to, node.getKind().name(), identity));
            }

            @Override public Void visitCompilationUnit(CompilationUnitTree node, Void unused) {
                if (inside(packageName)) span(node.getPackageName(), "declaration");
                return super.visitCompilationUnit(node, unused);
            }

            @Override public Void visitImport(ImportTree node, Void unused) {
                Tree imported = node.getQualifiedIdentifier();
                if (imported instanceof MemberSelectTree member && (member.getIdentifier().contentEquals("*") || node.isStatic())) {
                    imported = member.getExpression();
                }
                String qualified = imported.toString();
                TypeElement type = elements.getTypeElement(qualified);
                PackageElement owner = type == null ? elements.getPackageElement(qualified) : elements.getPackageOf(type);
                if (owner != null && inside(owner.getQualifiedName().toString())) span(imported, "reference");
                return super.visitImport(node, unused);
            }

            @Override public Void visitVariable(VariableTree node, Void unused) {
                Tree type = node.getType();
                if (type != null && end(type) < 0) {
                    // Attribution can populate invisible types for inferred lambda parameters and var.
                    // Their bindings are checked at the real uses, where the editor has source spans.
                    scan(node.getModifiers(), unused);
                    scan(node.getNameExpression(), unused);
                    return scan(node.getInitializer(), unused);
                }
                return super.visitVariable(node, unused);
            }

            @Override public Void visitIdentifier(IdentifierTree node, Void unused) {
                Element resolved = trees.getElement(getCurrentPath());
                if (resolved instanceof PackageElement pkg && inside(pkg.getQualifiedName().toString())) span(node, "reference");
                binding(node, resolved);
                return super.visitIdentifier(node, unused);
            }

            @Override public Void visitMemberSelect(MemberSelectTree node, Void unused) {
                Element resolved = trees.getElement(getCurrentPath());
                if (resolved instanceof PackageElement pkg && inside(pkg.getQualifiedName().toString()) ||
                    resolved instanceof TypeElement type && type.getQualifiedName().contentEquals(node.toString()) &&
                    inside(elements.getPackageOf(type).getQualifiedName().toString())) span(node, "reference");
                binding(node, resolved);
                return super.visitMemberSelect(node, unused);
            }

            @Override public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
                binding(node, trees.getElement(getCurrentPath()));
                return super.visitMethodInvocation(node, unused);
            }

            @Override public Void visitNewClass(NewClassTree node, Void unused) {
                binding(node, trees.getElement(getCurrentPath()));
                return super.visitNewClass(node, unused);
            }

            @Override public Void visitMemberReference(MemberReferenceTree node, Void unused) {
                binding(node, trees.getElement(getCurrentPath()));
                return super.visitMemberReference(node, unused);
            }
        }.scan(unit, null);
        boolean opposingNamespace = packageName.equals(other) || packageName.startsWith(other + ".");
        return object("uri", uri, "name", packageName, "competingNamespace", opposingNamespace,
            "spans", spans.values().stream().toList(), "bindings", bindings);
    }
}
