package rocketbrain.signature;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.DeclaredType;
import com.sun.source.tree.*;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import static rocketbrain.signature.SignatureInspector.location;
import static rocketbrain.signature.SignatureInspector.object;

/** Attributes local source occurrences without interpreting ownership or loading project classes. */
final class JavaDiagramRelations {
    private final Trees trees;
    private final SourcePositions positions;
    private final TypeElement owner;
    private final List<Map<String,Object>> relations;
    private final int limit;
    private final Set<String> observed = new HashSet<>();
    private int omitted;

    JavaDiagramRelations(Trees trees, TypeElement owner, List<Map<String,Object>> relations, int remaining) {
        this.trees=trees;
        this.positions=trees.getSourcePositions();
        this.owner=owner;
        this.relations=relations;
        this.limit=Math.min(240,remaining);
    }

    private void emit(TreePath occurrence, TypeElement target, String kind, String role, String member, String signature) {
        String id=target.getQualifiedName().toString();
        if (id.isEmpty() || target.equals(owner)) return;
        var at=location(occurrence.getCompilationUnit(),occurrence.getLeaf(),positions);
        long start=(long)at.get("start"), end=(long)at.get("end");
        if (start<0 || end<=start || end-start>4096) return;
        String reference=at.get("uri")+":"+start+":"+end+":"+kind+":"+role+":"+id+":"+member;
        if (observed.contains(reference)) return;
        if (observed.size()>=limit) { omitted++; return; }
        observed.add(reference);
        relations.add(object("target",id,"kind",kind,"role",role,"member",member,"signature",signature,"location",at));
    }

    private void type(TreePath parent, Tree tree, String kind, String role, String member, boolean argument) {
        if (tree==null) return;
        TreePath path=new TreePath(parent,tree);
        if (tree instanceof AnnotatedTypeTree annotated) {
            type(path,annotated.getUnderlyingType(),kind,role,member,argument);
        } else if (tree instanceof ArrayTypeTree array) {
            type(path,array.getType(),kind,role,member,argument);
        } else if (tree instanceof ParameterizedTypeTree parameterized) {
            type(path,parameterized.getType(),kind,role,member,argument);
            for (Tree component : parameterized.getTypeArguments()) type(path,component,kind,role,member,true);
        } else if (tree instanceof WildcardTree wildcard) {
            type(path,wildcard.getBound(),kind,role,member,argument);
        } else if (trees.getTypeMirror(path) instanceof DeclaredType bound && bound.asElement() instanceof TypeElement target) {
            emit(path,target,kind,role+(argument?"-argument":""),member,bound.toString());
        }
    }

    int inspect(TreePath declaration) {
        for (var element : owner.getEnclosedElements()) {
            TreePath path=trees.getPath(element);
            if (path==null || path.getCompilationUnit()!=declaration.getCompilationUnit()) continue;
            if (element instanceof VariableElement field && field.getKind()==ElementKind.FIELD && path.getLeaf() instanceof VariableTree variable) {
                type(path,variable.getType(),"associates","field",field.getSimpleName().toString(),false);
            } else if (element instanceof ExecutableElement method && path.getLeaf() instanceof MethodTree source) {
                String name=method.getKind()==ElementKind.CONSTRUCTOR ? owner.getSimpleName().toString() : method.getSimpleName().toString();
                type(path,source.getReturnType(),"uses","return",name,false);
                for (VariableTree parameter : source.getParameters()) {
                    type(new TreePath(path,parameter),parameter.getType(),"uses","parameter",name+"("+parameter.getName()+")",false);
                }
                for (ExpressionTree exception : source.getThrows()) type(path,exception,"uses","throws",name,false);
            }
        }

        new TreePathScanner<Void,String>() {
            @Override public Void visitClass(ClassTree node, String member) {
                return node==declaration.getLeaf()?super.visitClass(node,member):null;
            }
            @Override public Void visitMethod(MethodTree node, String member) {
                String name=node.getName().contentEquals("<init>")?owner.getSimpleName().toString():node.getName().toString();
                return super.visitMethod(node,name);
            }
            @Override public Void visitMethodInvocation(MethodInvocationTree node, String member) {
                if (trees.getElement(getCurrentPath()) instanceof ExecutableElement method && method.getKind()==ElementKind.METHOD &&
                        method.getEnclosingElement() instanceof TypeElement target) {
                    emit(new TreePath(getCurrentPath(),node.getMethodSelect()),target,"uses","call",member,SignatureInspector.key(method));
                }
                return super.visitMethodInvocation(node,member);
            }
            @Override public Void visitNewClass(NewClassTree node, String member) {
                type(getCurrentPath(),node.getIdentifier(),"uses","construct",member,false);
                return super.visitNewClass(node,member);
            }
        }.scan(declaration,owner.getSimpleName().toString());
        return omitted;
    }
}
