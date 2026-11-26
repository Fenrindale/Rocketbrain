package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.util.*;
import javax.lang.model.element.*;

import static rocketbrain.signature.SignatureInspector.object;

/** Reports exact source tokens that Javac binds to one public top-level class. */
final class TypeRenameInspector {
    static Map<String, Object> inspect(JavacTask task, List<CompilationUnitTree> units, String fqn, String conflict) {
        return inspect(task,units,fqn,conflict,false);
    }

    static Map<String, Object> inspect(JavacTask task, List<CompilationUnitTree> units, String fqn, String conflict, boolean binary) {
        var elements = task.getElements();
        var trees = Trees.instance(task);
        var positions = trees.getSourcePositions();
        var target = elements.getTypeElement(fqn);
        var owner = target == null ? null : trees.getPath(target);
        boolean occupied = elements.getTypeElement(conflict) != null;
        if (target == null || (binary ? owner != null : owner == null || !(owner.getLeaf() instanceof ClassTree)) ||
                target.getKind() != ElementKind.CLASS || target.getNestingKind() != NestingKind.TOP_LEVEL ||
                !target.getModifiers().contains(Modifier.PUBLIC)) {
            return object("supported", false, "destinationOccupied", occupied);
        }
        String leaf = target.getSimpleName().toString();
        var spans = new LinkedHashMap<String, Map<String, Object>>();
        for (var unit : units) {
            String uri = unit.getSourceFile().toUri().toString();
            String text;
            try { text = unit.getSourceFile().getCharContent(true).toString(); }
            catch (java.io.IOException error) { throw new IllegalStateException("Cannot read the attributed source.", error); }
            new TreePathScanner<Void,Void>() {
                int start(Tree node) { return (int) positions.getStartPosition(unit,node); }
                int end(Tree node) { return (int) positions.getEndPosition(unit,node); }
                void record(int start,int end,String role) {
                    if (start < 0 || end > text.length() || end-start != leaf.length() || !text.regionMatches(start,leaf,0,leaf.length())) {
                        throw new IllegalArgumentException("A Java type binding does not have an ordinary source identifier.");
                    }
                    spans.putIfAbsent(uri+":"+start,object("uri",uri,"start",start,"end",end,"role",role));
                    if (spans.size()>3500) throw new IllegalArgumentException("The Java type reference count exceeds its review bound.");
                }
                @Override public Void visitIdentifier(IdentifierTree node,Void unused) {
                    if (start(node)>=0 && end(node)>=0 && target.equals(trees.getElement(getCurrentPath()))) {
                        record(start(node),end(node),"reference");
                    }
                    return super.visitIdentifier(node,unused);
                }
                @Override public Void visitMemberSelect(MemberSelectTree node,Void unused) {
                    if (end(node)>=0 && target.equals(trees.getElement(getCurrentPath()))) {
                        record(end(node)-leaf.length(),end(node),"qualified-reference");
                    }
                    return super.visitMemberSelect(node,unused);
                }
                @Override public Void visitImport(ImportTree node,Void unused) {
                    // Import selectors can lack a TreePath element for the full import.
                    // A literal exact type owner is still available through Javac's named element table.
                    Tree identifier = node.getQualifiedIdentifier();
                    String name = identifier.toString();
                    String type = node.isStatic() ? name.substring(0,name.lastIndexOf('.')) : name;
                    Tree typeTree = node.isStatic() && identifier instanceof MemberSelectTree member ? member.getExpression() : identifier;
                    if (type.equals(fqn) && target.equals(elements.getTypeElement(type)) && end(typeTree)>=0) {
                        record(end(typeTree)-leaf.length(),end(typeTree),"import");
                    }
                    return super.visitImport(node,unused);
                }
                @Override public Void visitMethod(MethodTree node,Void unused) {
                    if (start(node)>=0 && end(node)>=0 && trees.getElement(getCurrentPath()) instanceof ExecutableElement constructor &&
                            constructor.getKind()==ElementKind.CONSTRUCTOR && target.equals(constructor.getEnclosingElement())) {
                        int boundary = node.getParameters().isEmpty() ?
                            (node.getBody()==null ? end(node) : start(node.getBody())) : start(node.getParameters().getFirst());
                        int cursor = text.lastIndexOf('(',boundary-1);
                        while (cursor>start(node) && Character.isWhitespace(text.charAt(cursor-1))) cursor--;
                        record(cursor-leaf.length(),cursor,"constructor");
                    }
                    return super.visitMethod(node,unused);
                }
            }.scan(unit,null);
        }
        if (binary) return object("supported",true,"destinationOccupied",occupied,"binaryOwner",true,
            "spans",spans.values().stream().toList());
        return object("supported",true,"destinationOccupied",occupied,
            "declaration",object("uri",owner.getCompilationUnit().getSourceFile().toUri().toString(),
                "start",positions.getStartPosition(owner.getCompilationUnit(),owner.getLeaf()),
                "end",positions.getEndPosition(owner.getCompilationUnit(),owner.getLeaf()),
                "annotations",target.getAnnotationMirrors().stream().map(annotation->annotation.getAnnotationType().toString()).toList()),
            "spans",spans.values().stream().toList());
    }
}
