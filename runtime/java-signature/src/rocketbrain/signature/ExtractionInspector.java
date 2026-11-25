package rocketbrain.signature;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import com.sun.source.tree.*;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import static rocketbrain.signature.SignatureInspector.object;

/** Attributes the declaration and each use introduced by an ordinary JDT extraction. */
final class ExtractionInspector {
    private final JavacTask task;
    private final Trees trees;
    private final SourcePositions positions;
    private final CompilationUnitTree unit;
    private final String source;

    ExtractionInspector(JavacTask task, CompilationUnitTree unit, String source) {
        this.task = task;
        this.trees = Trees.instance(task);
        this.positions = trees.getSourcePositions();
        this.unit = unit;
        this.source = source;
    }

    private int start(Tree tree) { return (int) positions.getStartPosition(unit, tree); }
    private int end(Tree tree) { return (int) positions.getEndPosition(unit, tree); }
    private Map<String,Object> range(Tree tree) { return object("start",start(tree),"end",end(tree)); }
    private boolean token(int offset, String name) {
        int after = offset + name.length();
        return offset >= 0 && after <= source.length() && source.startsWith(name,offset) &&
            (offset == 0 || !Character.isJavaIdentifierPart(source.charAt(offset-1))) &&
            (after == source.length() || !Character.isJavaIdentifierPart(source.charAt(after)));
    }

    private int declarationName(VariableTree tree) {
        String name = tree.getName().toString();
        int from = end(tree.getType()), boundary = tree.getInitializer() == null ? end(tree) : start(tree.getInitializer());
        if (from < 0 || boundary < from) return -1;
        int candidate = source.indexOf(name,from);
        while (candidate >= 0 && candidate < boundary) {
            if (token(candidate,name)) return candidate;
            candidate = source.indexOf(name,candidate+1);
        }
        return -1;
    }

    private int referenceName(ExpressionTree tree, String name) {
        return tree instanceof MemberSelectTree ? end(tree)-name.length() : start(tree);
    }

    private VariableElement binding(int offset, String name) {
        var found = new VariableElement[1];
        new TreePathScanner<Void,Void>() {
            private void remember(int at) {
                if (at == offset && trees.getElement(getCurrentPath()) instanceof VariableElement value && value.getSimpleName().contentEquals(name)) found[0] = value;
            }
            @Override public Void visitVariable(VariableTree tree, Void unused) {
                if (tree.getName().contentEquals(name)) remember(declarationName(tree));
                return super.visitVariable(tree,unused);
            }
            @Override public Void visitIdentifier(IdentifierTree tree, Void unused) {
                if (tree.getName().contentEquals(name)) remember(start(tree));
                return super.visitIdentifier(tree,unused);
            }
            @Override public Void visitMemberSelect(MemberSelectTree tree, Void unused) {
                if (tree.getIdentifier().contentEquals(name)) remember(referenceName(tree,name));
                return super.visitMemberSelect(tree,unused);
            }
        }.scan(unit,null);
        return found[0];
    }

    private TreePath containingStatement(TreePath path) {
        TreePath parent = path.getParentPath();
        Tree value = path.getLeaf();
        if (parent.getLeaf() instanceof ReturnTree statement && statement.getExpression() == value ||
                parent.getLeaf() instanceof VariableTree declaration && declaration.getInitializer() == value &&
                    trees.getElement(parent) instanceof VariableElement variable && variable.getKind() == ElementKind.LOCAL_VARIABLE) {
            return parent.getParentPath().getLeaf() instanceof BlockTree ? parent : null;
        }
        return null;
    }

    Map<String,Object> inspect(String kind, int offset, String name) {
        boolean field = kind.equals("field");
        VariableElement variable = token(offset,name) ? binding(offset,name) : null;
        TreePath declaration = variable == null ? null : trees.getPath(variable);
        if (declaration == null || declaration.getCompilationUnit() != unit || !(declaration.getLeaf() instanceof VariableTree node) ||
                variable.getKind() != (field ? ElementKind.FIELD : ElementKind.LOCAL_VARIABLE) ||
                field && (!variable.getModifiers().contains(Modifier.PRIVATE) || node.getInitializer() != null)) {
            return object("error","Javac could not identify the exact extracted declaration in the current Java file.");
        }
        int nameStart = declarationName(node);
        if (nameStart < 0) return object("error","The introduced Java declaration has no exact name span.");
        var uses = new ArrayList<TreePath>();
        var occupied = new LinkedHashSet<String>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitVariable(VariableTree tree, Void unused) {
                if (!variable.equals(trees.getElement(getCurrentPath()))) occupied.add(tree.getName().toString());
                return super.visitVariable(tree,unused);
            }
            @Override public Void visitIdentifier(IdentifierTree tree, Void unused) {
                if (variable.equals(trees.getElement(getCurrentPath()))) uses.add(getCurrentPath());
                else occupied.add(tree.getName().toString());
                return super.visitIdentifier(tree,unused);
            }
            @Override public Void visitMemberSelect(MemberSelectTree tree, Void unused) {
                if (variable.equals(trees.getElement(getCurrentPath()))) uses.add(getCurrentPath());
                return super.visitMemberSelect(tree,unused);
            }
        }.scan(unit,null);
        TreePath read = null, write = null;
        ExpressionTree initializer = node.getInitializer();
        for (TreePath use : uses) {
            TreePath parent = use.getParentPath();
            if (field && write == null && parent.getLeaf() instanceof AssignmentTree assignment && assignment.getVariable() == use.getLeaf() &&
                    parent.getParentPath().getLeaf() instanceof ExpressionStatementTree statement && statement.getExpression() == assignment) {
                write = parent.getParentPath();
                initializer = assignment.getExpression();
            } else if (read == null && containingStatement(use) != null) read = use;
            else return object("unsupportedSelection",true,"error","The named extraction must keep exactly one use at the original expression and one evaluation.");
        }
        if (read == null || field && write == null || initializer == null || uses.size() != (field ? 2 : 1)) {
            return object("unsupportedSelection",true,"error","Select a whole return expression or local initializer in a Java block.");
        }
        TreePath statement = containingStatement(read);
        List<? extends StatementTree> block = ((BlockTree) statement.getParentPath().getLeaf()).getStatements();
        int index = block.indexOf(statement.getLeaf());
        Tree introduced = field ? write.getLeaf() : node;
        if (index <= 0 || block.get(index-1) != introduced) return object("unsupportedSelection",true,"error","The extraction must evaluate the expression exactly once in its current block.");
        TreePath method = statement;
        while (method != null && !(method.getLeaf() instanceof MethodTree)) method = method.getParentPath();
        if (method == null || !(trees.getElement(method) instanceof ExecutableElement executable) ||
                !(executable.getEnclosingElement() instanceof TypeElement owner) || owner.getQualifiedName().length() == 0 ||
                field && !owner.equals(variable.getEnclosingElement())) return object("unsupportedSelection",true,"error","Select an expression within a named Java class method.");
        for (Element member : task.getElements().getAllMembers(owner)) {
            if (member.getKind().isField() && !member.equals(variable)) occupied.add(member.getSimpleName().toString());
        }
        var names = new ArrayList<Map<String,Object>>();
        names.add(object("start",nameStart,"end",nameStart+name.length(),"role","declaration"));
        for (TreePath use : uses) {
            int at = referenceName((ExpressionTree)use.getLeaf(),name);
            if (!token(at,name)) return object("error","The extracted binding contains an out-of-range Java name.");
            names.add(object("start",at,"end",at+name.length(),"role",use == read ? "read" : "assignment"));
        }
        names.sort(Comparator.comparingInt(entry -> (int) entry.get("start")));
        return object("kind",kind,"type",variable.asType().toString(),"owner",owner.getQualifiedName().toString(),
            "method",executable.getSimpleName().toString(),"staticField",field && variable.getModifiers().contains(Modifier.STATIC),
            "name",name,"names",names,"occupiedNames",occupied,"declaration",range(node),"initializer",range(initializer),
            "read",range(read.getLeaf()),"assignment",write == null ? null : range(write.getLeaf()));
    }
}
